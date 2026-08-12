import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, max, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
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
   * to Turso. Correlated scalar subqueries collapse that to one.
   */
  async getCompletionSnapshot(
    userId: number,
    courseId: number,
  ): Promise<CompletionSnapshot> {
    const totalLessons = this.db
      .select({ value: count() })
      .from(lessons)
      .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
      .where(
        and(
          eq(courseModules.courseId, courseId),
          eq(lessons.isActive, 1),
          eq(courseModules.isActive, 1),
        ),
      );

    const completedLessons = this.db
      .select({ value: count() })
      .from(userLessonCompletions)
      .innerJoin(lessons, eq(lessons.id, userLessonCompletions.lessonId))
      .innerJoin(courseModules, eq(courseModules.id, lessons.moduleId))
      .where(
        and(
          eq(courseModules.courseId, courseId),
          eq(lessons.isActive, 1),
          eq(courseModules.isActive, 1),
          eq(userLessonCompletions.userId, userId),
        ),
      );

    const activeAssessments = this.db
      .select({ value: count() })
      .from(assessments)
      .where(
        and(eq(assessments.courseId, courseId), eq(assessments.isActive, 1)),
      );

    const bestScore = this.db
      .select({ value: max(userAssessmentAttempts.percentage) })
      .from(userAssessmentAttempts)
      .innerJoin(
        assessments,
        eq(assessments.id, userAssessmentAttempts.assessmentId),
      )
      .where(
        and(
          eq(assessments.courseId, courseId),
          eq(assessments.isActive, 1),
          eq(userAssessmentAttempts.userId, userId),
        ),
      );

    const passedAttempts = this.db
      .select({ value: count() })
      .from(userAssessmentAttempts)
      .innerJoin(
        assessments,
        eq(assessments.id, userAssessmentAttempts.assessmentId),
      )
      .where(
        and(
          eq(assessments.courseId, courseId),
          eq(assessments.isActive, 1),
          eq(userAssessmentAttempts.userId, userId),
          eq(userAssessmentAttempts.isPassed, 1),
        ),
      );

    const rows = await this.db.all<{
      total_lessons: number;
      completed_lessons: number;
      assessment_count: number;
      best_score: number | null;
      passed_count: number;
    }>(sql`
      SELECT
        (${totalLessons})      AS total_lessons,
        (${completedLessons})  AS completed_lessons,
        (${activeAssessments}) AS assessment_count,
        (${bestScore})         AS best_score,
        (${passedAttempts})    AS passed_count
    `);
    const row = rows[0];

    return {
      totalLessons: Number(row.total_lessons),
      completedLessons: Number(row.completed_lessons),
      hasAssessment: Number(row.assessment_count) > 0,
      hasPassed: Number(row.passed_count) > 0,
      bestScore: row.best_score === null ? null : Number(row.best_score),
    };
  }

  async findByUserAndCourse(userId: number, courseId: number) {
    const rows = await this.db
      .select({ id: certificates.id, isRevoked: certificates.isRevoked })
      .from(certificates)
      .where(
        and(
          eq(certificates.userId, userId),
          eq(certificates.courseId, courseId),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async insert(input: {
    userId: number;
    courseId: number;
    certificateCode: string;
    issuedAt: string;
    finalScore: number | null;
  }): Promise<number> {
    const [created] = await this.db
      .insert(certificates)
      .values(input)
      .returning({ id: certificates.id });

    return created.id;
  }

  /** Learner's own certificates. One join, no per-row follow-up queries. */
  async listForLearner(userId: number) {
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
      .where(eq(certificates.userId, userId))
      .orderBy(desc(certificates.issuedAt));
  }

  async findDetailById(id: number) {
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
      .where(eq(certificates.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  async listForAdmin(filters: { userId?: number; courseId?: number }) {
    const conditions = [
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
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(certificates.issuedAt));
  }

  /** Verification lookup. Selects no learner-identifying column at all. */
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

  async revoke(id: number, adminId: number): Promise<void> {
    await this.db
      .update(certificates)
      .set({
        isRevoked: 1,
        revokedAt: new Date().toISOString(),
        revokedBy: adminId,
      })
      .where(eq(certificates.id, id));
  }

  async reinstate(
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
      .where(eq(certificates.id, id));
  }

  async findStatusById(id: number) {
    const rows = await this.db
      .select({
        id: certificates.id,
        userId: certificates.userId,
        courseId: certificates.courseId,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .where(eq(certificates.id, id))
      .limit(1);

    return rows[0] ?? null;
  }
}
