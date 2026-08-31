import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, max, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import {
  assessments,
  certificates,
  courseModules,
  courses,
  lessons,
  userAssessmentAttempts,
  userLessonCompletions,
  users,
} from '@/database/schema';

export interface CompletionSnapshot {
  totalLessons: number;
  completedLessons: number;
  hasAssessment: boolean;
  hasPassed: boolean;
  bestScore: number | null;
  /**
   * Set when this course is a live/offline session's companion training
   * (`courses.session_id`). Those certificates are the admin's to issue by
   * hand, so auto-issue steps aside — see CertificatesService.autoIssue.
   */
  sessionId: number | null;
}

@Injectable()
export class CertificatesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Everything the eligibility rule needs, in ONE round trip.
   *
   * The legacy `evaluateCourseCompletion()` issued three sequential queries per
   * course (lesson counts, best score, "does an assessment exist"). Because the
   * course list called it per row, a learner with 8 courses cost 24 round trips
   * to Postgres. Correlated scalar subqueries collapse that to one.
   *
   * `scope` is first on every method here (and across the sibling modules): it
   * is required, security-relevant, reads like a context argument, and can
   * never collide with an optional or defaulted parameter that follows it.
   */
  async getCompletionSnapshot(
    scope: OrgScope,
    userId: number,
    courseId: number,
  ): Promise<CompletionSnapshot> {
    // `courses` is the query root here: every subquery below is independent
    // (no shared FROM), so each one re-anchors on it rather than trusting an
    // already-scoped caller. A courseId from another org resolves to zero
    // rows everywhere, which `evaluate()` reads as `no_lessons`.
    const totalLessons = this.db
      .select({ value: count() })
      .from(lessons)
      .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
      .innerJoin(courses, eq(courses.id, courseModules.courseId))
      .where(
        and(
          eq(courseModules.courseId, courseId),
          eq(lessons.isActive, 1),
          eq(courseModules.isActive, 1),
          eq(courses.organizationId, scope.organizationId),
        ),
      );

    const completedLessons = this.db
      .select({ value: count() })
      .from(userLessonCompletions)
      .innerJoin(lessons, eq(lessons.id, userLessonCompletions.lessonId))
      .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
      .innerJoin(courses, eq(courses.id, courseModules.courseId))
      .where(
        and(
          eq(courseModules.courseId, courseId),
          eq(lessons.isActive, 1),
          eq(courseModules.isActive, 1),
          eq(userLessonCompletions.userId, userId),
          eq(courses.organizationId, scope.organizationId),
        ),
      );

    const activeAssessments = this.db
      .select({ value: count() })
      .from(assessments)
      .innerJoin(courses, eq(courses.id, assessments.courseId))
      .where(
        and(
          eq(assessments.courseId, courseId),
          eq(assessments.isActive, 1),
          eq(courses.organizationId, scope.organizationId),
        ),
      );

    const bestScore = this.db
      .select({ value: max(userAssessmentAttempts.percentage) })
      .from(userAssessmentAttempts)
      .innerJoin(
        assessments,
        eq(assessments.id, userAssessmentAttempts.assessmentId),
      )
      .innerJoin(courses, eq(courses.id, assessments.courseId))
      .where(
        and(
          eq(assessments.courseId, courseId),
          eq(assessments.isActive, 1),
          eq(userAssessmentAttempts.userId, userId),
          eq(courses.organizationId, scope.organizationId),
        ),
      );

    const passedAttempts = this.db
      .select({ value: count() })
      .from(userAssessmentAttempts)
      .innerJoin(
        assessments,
        eq(assessments.id, userAssessmentAttempts.assessmentId),
      )
      .innerJoin(courses, eq(courses.id, assessments.courseId))
      .where(
        and(
          eq(assessments.courseId, courseId),
          eq(assessments.isActive, 1),
          eq(userAssessmentAttempts.userId, userId),
          eq(userAssessmentAttempts.isPassed, 1),
          eq(courses.organizationId, scope.organizationId),
        ),
      );

    const sessionId = this.db
      .select({ value: courses.sessionId })
      .from(courses)
      .where(
        and(eq(courses.id, courseId), eq(courses.organizationId, scope.organizationId)),
      );

    const rows = await this.db.all<{
      total_lessons: number;
      completed_lessons: number;
      assessment_count: number;
      best_score: number | null;
      passed_count: number;
      session_id: number | null;
    }>(sql`
      SELECT
        (${totalLessons})      AS total_lessons,
        (${completedLessons})  AS completed_lessons,
        (${activeAssessments}) AS assessment_count,
        (${bestScore})         AS best_score,
        (${passedAttempts})    AS passed_count,
        (${sessionId})         AS session_id
    `);
    const row = rows[0];

    return {
      totalLessons: Number(row.total_lessons),
      completedLessons: Number(row.completed_lessons),
      hasAssessment: Number(row.assessment_count) > 0,
      hasPassed: Number(row.passed_count) > 0,
      bestScore: row.best_score === null ? null : Number(row.best_score),
      sessionId: row.session_id === null ? null : Number(row.session_id),
    };
  }

  /** Existence checks for a manual issue — cheap, explicit column lists. */
  async findLearner(scope: OrgScope, userId: number) {
    const rows = await this.db.all<{ id: number; role: string }>(sql`
      SELECT u.id, u.role FROM users u
      WHERE u.id = ${userId} AND u.role = 'learner' AND ${orgScope('u', scope)}
    `);
    return rows[0] ?? null;
  }

  async findCourse(scope: OrgScope, courseId: number) {
    const rows = await this.db.all<{ id: number; name: string }>(sql`
      SELECT c.id, c.name FROM courses c
      WHERE c.id = ${courseId} AND ${orgScope('c', scope)}
    `);
    return rows[0] ?? null;
  }

  async findByUserAndCourse(scope: OrgScope, userId: number, courseId: number) {
    const rows = await this.db
      .select({ id: certificates.id, isRevoked: certificates.isRevoked })
      .from(certificates)
      .where(
        and(
          eq(certificates.userId, userId),
          eq(certificates.courseId, courseId),
          eq(certificates.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  /** `certificates` is an activity table — the row always takes the learner's org (§3.3). */
  async insert(
    scope: OrgScope,
    input: {
      userId: number;
      courseId: number;
      certificateCode: string;
      issuedAt: string;
      finalScore: number | null;
    },
  ): Promise<number> {
    const [created] = await this.db
      .insert(certificates)
      .values({ ...input, organizationId: scope.organizationId })
      .returning({ id: certificates.id });

    return created.id;
  }

  /** Learner's own certificates. One join, no per-row follow-up queries. */
  async listForLearner(scope: OrgScope, userId: number) {
    return this.db
      .select({
        id: certificates.id,
        certificateCode: certificates.certificateCode,
        courseName: courses.name,
        issuedAt: certificates.issuedAt,
        finalScore: certificates.finalScore,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .innerJoin(courses, eq(courses.id, certificates.courseId))
      .where(
        and(
          eq(certificates.userId, userId),
          eq(certificates.organizationId, scope.organizationId),
        ),
      )
      .orderBy(desc(certificates.issuedAt));
  }

  async findDetailById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select({
        id: certificates.id,
        userId: certificates.userId,
        certificateCode: certificates.certificateCode,
        firstName: users.firstName,
        lastName: users.lastName,
        courseName: courses.name,
        issuedAt: certificates.issuedAt,
        finalScore: certificates.finalScore,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .innerJoin(courses, eq(courses.id, certificates.courseId))
      .innerJoin(users, eq(users.id, certificates.userId))
      .where(
        and(
          eq(certificates.id, id),
          eq(certificates.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async listForAdmin(
    scope: OrgScope,
    filters: { userId?: number; courseId?: number },
  ) {
    const conditions = [
      eq(certificates.organizationId, scope.organizationId),
      filters.userId !== undefined
        ? eq(certificates.userId, filters.userId)
        : undefined,
      filters.courseId !== undefined
        ? eq(certificates.courseId, filters.courseId)
        : undefined,
    ].filter(Boolean);

    return this.db
      .select({
        id: certificates.id,
        firstName: users.firstName,
        lastName: users.lastName,
        courseName: courses.name,
        certificateCode: certificates.certificateCode,
        issuedAt: certificates.issuedAt,
        finalScore: certificates.finalScore,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .innerJoin(courses, eq(courses.id, certificates.courseId))
      .innerJoin(users, eq(users.id, certificates.userId))
      .where(and(...conditions))
      .orderBy(desc(certificates.issuedAt));
  }

  /**
   * Verification lookup. Selects no learner-identifying column at all.
   *
   * Deliberately NOT scoped, unlike every other method here: the public verify
   * endpoint is cross-tenant by design (§3.6, §6.16) and `certificate_code`
   * stays globally unique for exactly that reason.
   */
  async findByCodeForVerification(code: string) {
    const rows = await this.db
      .select({
        courseName: courses.name,
        issuedAt: certificates.issuedAt,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .innerJoin(courses, eq(courses.id, certificates.courseId))
      .where(eq(certificates.certificateCode, code))
      .limit(1);

    return rows[0] ?? null;
  }

  async revoke(scope: OrgScope, id: number, adminId: number): Promise<void> {
    await this.db
      .update(certificates)
      .set({
        isRevoked: 1,
        revokedAt: new Date().toISOString(),
        revokedBy: adminId,
      })
      .where(
        and(
          eq(certificates.id, id),
          eq(certificates.organizationId, scope.organizationId),
        ),
      );
  }

  async reinstate(
    scope: OrgScope,
    id: number,
    certificateCode: string,
    issuedAt: string,
  ): Promise<void> {
    await this.db
      .update(certificates)
      .set({
        isRevoked: 0,
        revokedAt: null,
        revokedBy: null,
        certificateCode,
        issuedAt,
      })
      .where(
        and(
          eq(certificates.id, id),
          eq(certificates.organizationId, scope.organizationId),
        ),
      );
  }

  async findStatusById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select({
        id: certificates.id,
        userId: certificates.userId,
        courseId: certificates.courseId,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .where(
        and(
          eq(certificates.id, id),
          eq(certificates.organizationId, scope.organizationId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }
}
