import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, max, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import {
  assessments,
  certificates,
  courseModules,
  courses,
  journeys,
  lessons,
  organizations,
  sessions,
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
  /** Set when the course IS an approved external certification (0036). */
  externalCertificationId: number | null;
  /**
   * For the completion notification's wording. Selected here rather than
   * fetched separately because this method already anchors on `courses` six
   * times — one more scalar subquery costs nothing, and a second round trip
   * on the completion path would (§7.5).
   */
  courseName: string | null;
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
    /*
     * THE COURSE IS CONTENT, SO IT MAY BE PLATFORM-OWNED.
     *
     * Every subquery below used `courses.organization_id = <this org>`, which
     * is `orgScope` applied to a CONTENT row — §10.12's rule read backwards.
     * A course Edstellar publishes to every tenant carries the PLATFORM org's
     * id, so for a tenant's learner all seven resolved to zero rows:
     * `totalLessons` came back 0, `evaluate()` read that as `no_lessons`, and
     * `autoIssue` returned null. A learner could finish a platform course
     * completely and never be issued a certificate, silently.
     *
     * The Drizzle equivalent of `contentScope` — the raw-SQL helper cannot be
     * used inside a query-builder `and()`. One constant, so the seven call
     * sites cannot drift apart.
     */
    const courseIsVisible = inArray(courses.organizationId, [
      scope.organizationId,
      scope.platformOrganizationId,
    ]);
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
          courseIsVisible,
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
          courseIsVisible,
          // The completion is ACTIVITY and belongs to ONE tenant, even when
          // the course is shared. Without this, a platform course completed
          // in another org would count toward this learner's certificate.
          eq(userLessonCompletions.organizationId, scope.organizationId),
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
          courseIsVisible,
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
          courseIsVisible,
          // Activity again — see the note on completedLessons.
          eq(userAssessmentAttempts.organizationId, scope.organizationId),
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
          courseIsVisible,
          eq(userAssessmentAttempts.organizationId, scope.organizationId),
        ),
      );

    const sessionId = this.db
      .select({ value: courses.sessionId })
      .from(courses)
      .where(
        and(eq(courses.id, courseId), courseIsVisible),
      );

    /**
     * Is this course one learner's approved EXTERNAL certification (0036)?
     *
     * Read for the same reason `sessionId` is: neither kind auto-issues. An
     * external certification already HAS a certificate — the one the
     * awarding body gave them — and minting a second in this product's name
     * would be claiming credit for training it did not deliver.
     */
    const externalCertificationId = this.db
      .select({ value: courses.externalCertificationId })
      .from(courses)
      .where(
        and(eq(courses.id, courseId), courseIsVisible),
      );

    const courseName = this.db
      .select({ value: courses.name })
      .from(courses)
      .where(
        and(eq(courses.id, courseId), courseIsVisible),
      );

    const rows = await this.db.all<{
      total_lessons: number;
      completed_lessons: number;
      assessment_count: number;
      best_score: number | null;
      passed_count: number;
      session_id: number | null;
      external_certification_id: number | null;
      course_name: string | null;
    }>(sql`
      SELECT
        (${totalLessons})      AS total_lessons,
        (${completedLessons})  AS completed_lessons,
        (${activeAssessments}) AS assessment_count,
        (${bestScore})         AS best_score,
        (${passedAttempts})    AS passed_count,
        (${sessionId})         AS session_id,
        (${externalCertificationId}) AS external_certification_id,
        (${courseName})        AS course_name
    `);
    const row = rows[0];

    return {
      totalLessons: Number(row.total_lessons),
      completedLessons: Number(row.completed_lessons),
      hasAssessment: Number(row.assessment_count) > 0,
      hasPassed: Number(row.passed_count) > 0,
      bestScore: row.best_score === null ? null : Number(row.best_score),
      sessionId: row.session_id === null ? null : Number(row.session_id),
      externalCertificationId:
        row.external_certification_id === null
          ? null
          : Number(row.external_certification_id),
      courseName: row.course_name ?? null,
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
      WHERE c.id = ${courseId} AND ${contentScope('c', scope)}
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

  /**
   * A journey certificate's counterpart to `findByUserAndCourse` — checked
   * before issuing so a replayed completion trigger never duplicates one,
   * including a revoked row (§3.4, matching `autoIssue`'s own rule for
   * course certificates).
   */
  async findByUserAndJourney(scope: OrgScope, userId: number, journeyId: number) {
    const rows = await this.db.all<{ id: number; is_revoked: number }>(sql`
      SELECT id, is_revoked FROM certificates
      WHERE user_id = ${userId} AND journey_id = ${journeyId}
        AND organization_id = ${scope.organizationId}
      LIMIT 1
    `);
    return rows[0] ? { id: rows[0].id, isRevoked: rows[0].is_revoked } : null;
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

  /**
   * A journey certificate's `course_id` is NULL, which the Drizzle schema
   * still types as NOT NULL until `scripts/migrate-journey-certificates.mjs`
   * (a human checkpoint, §3.4) relaxes the live column — so this goes around
   * the query builder with an explicit NULL rather than fighting that type.
   */
  async insertJourney(
    scope: OrgScope,
    input: {
      userId: number;
      journeyId: number;
      certificateCode: string;
      issuedAt: string;
      finalScore: number | null;
    },
  ): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO certificates
        (organization_id, user_id, course_id, journey_id, certificate_code, issued_at, final_score, is_revoked)
      VALUES (${scope.organizationId}, ${input.userId}, NULL, ${input.journeyId},
              ${input.certificateCode}, ${input.issuedAt}, ${input.finalScore}, 0)
      RETURNING id
    `);
    return rows[0].id;
  }

  /**
   * Learner's own certificates. One join, no per-row follow-up queries.
   *
   * Both `courses` and `journeys` are LEFT joins, and both name columns are
   * returned — a course certificate carries `courseName` and a NULL
   * `journeyName`, a journey certificate the reverse. Additive: existing
   * readers that only look at `courseName` are unaffected (§5).
   */
  async listForLearner(scope: OrgScope, userId: number) {
    return this.db
      .select({
        id: certificates.id,
        // Public UUID for the deep link (?certificate=<uuid>) and the detail
        // fetch, so neither names the sequential id (0046).
        publicId: certificates.publicId,
        certificateCode: certificates.certificateCode,
        courseName: courses.name,
        journeyName: journeys.title,
        // Says which KIND of certificate this is: set for a session's
        // companion training (§10.7). See `certificateKind`.
        sessionId: courses.sessionId,
        issuedAt: certificates.issuedAt,
        finalScore: certificates.finalScore,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .leftJoin(courses, eq(courses.id, certificates.courseId))
      .leftJoin(journeys, eq(journeys.id, certificates.journeyId))
      .where(
        and(
          eq(certificates.userId, userId),
          eq(certificates.organizationId, scope.organizationId),
        ),
      )
      .orderBy(desc(certificates.issuedAt));
  }

  /**
   * The tenant's certificate-code prefix, or null to follow the default.
   *
   * Read here rather than through `OrganizationsService` because that module
   * already depends on this one's neighbours and injecting it would be a
   * cycle for a single column. It is one indexed read by primary key, taken
   * once per issue — not per certificate in a list.
   */
  async findCertificatePrefix(scope: OrgScope): Promise<string | null> {
    const [row] = await this.db
      .select({ prefix: organizations.certificatePrefix })
      .from(organizations)
      .where(eq(organizations.id, scope.organizationId))
      .limit(1);
    return row?.prefix ?? null;
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
        journeyName: journeys.title,
        issuedAt: certificates.issuedAt,
        finalScore: certificates.finalScore,
        isRevoked: certificates.isRevoked,
        /*
         * WHOSE certificate this is, by organization.
         *
         * Joined on `certificates.organization_id`, which is the LEARNER's
         * org, not the course's — so a platform-authored course completed at
         * Invensis prints "Invensis Technologies". The document belongs to
         * the employer who put the person through the training; Edstellar
         * authored the material, which is a different claim.
         */
        organizationName: organizations.name,
        // The tenant's own mark, printed beside its name on the document.
        // Null is the normal case and the certificate falls back to the
        // built-in layered-diamond rather than leaving a gap.
        organizationLogoUrl: organizations.logoUrl,
        // Who signs it (0039). Read at render time, so a re-download carries
        // the signatory the organisation names now. Both null by default.
        signatoryName: organizations.certificateSignatoryName,
        signatoryTitle: organizations.certificateSignatoryTitle,
        /*
         * For the certificate document's meta row, which names the category
         * and the course's length beside the issue date.
         *
         * Both come from the course and are null for a JOURNEY certificate,
         * which has no single course behind it — the document renders only
         * the fields it has rather than printing an em dash for a fact that
         * does not exist at that level.
         */
        category: courses.category,
        durationMinutes: sql<number | null>`(
          SELECT SUM(l.duration_minutes)
            FROM lessons l
            JOIN course_modules cm ON cm.id = l.module_id
           WHERE cm.course_id = ${certificates.courseId}
             AND l.is_active = 1 AND cm.is_active = 1
        )`,

        /*
         * ── A SESSION certificate ──
         *
         * Issued against the session's companion training course (§10.7), so
         * `courses.session_id` is what says this is one, and the sitting's
         * own facts come from `sessions`. `durationMinutes` above already IS
         * the sitting's length: the companion lesson's duration is the
         * scheduled length. All null for any other certificate.
         */
        sessionId: courses.sessionId,
        sessionTitle: sessions.title,
        sessionType: sessions.sessionType,
        sessionDate: sessions.date,
        sessionTrainer: sessions.trainer,
        // A ROOM for ILT, a MEETING URL for Virtual — the service decides
        // what of it is fit to print.
        sessionVenue: sessions.venueUrl,
        // The path's own subtitle ("Sales · Role Path"), printed under its name.
        journeyTag: journeys.tag,

        /*
         * ── A LEARNING PATH certificate ──
         *
         * Its courses in the path's own order, its total length, and when
         * THIS learner finished it. Correlated subqueries in the same round
         * trip (§7.1). The courses are the path's CONTENT, so no activity
         * predicate; completedAt is the learner's own enrolment row, scoped
         * to this certificate's organization.
         */
        pathCourses: sql<string[] | null>`(
          SELECT json_agg(c2.name ORDER BY jc.sort_order, jc.id)
            FROM journey_courses jc
            JOIN courses c2 ON c2.id = jc.course_id
           WHERE jc.journey_id = ${certificates.journeyId}
        )`,
        pathDurationMinutes: sql<number | null>`(
          SELECT SUM(l.duration_minutes)
            FROM journey_courses jc
            JOIN course_modules cm ON cm.course_id = jc.course_id AND cm.is_active = 1
            JOIN lessons l ON l.module_id = cm.id AND l.is_active = 1
           WHERE jc.journey_id = ${certificates.journeyId}
        )`,
        pathCompletedAt: sql<string | null>`(
          SELECT je.completed_at
            FROM journey_enrollments je
           WHERE je.journey_id = ${certificates.journeyId}
             AND je.user_id = ${certificates.userId}
             AND je.organization_id = ${certificates.organizationId}
           LIMIT 1
        )`,
      })
      .from(certificates)
      .leftJoin(courses, eq(courses.id, certificates.courseId))
      .leftJoin(journeys, eq(journeys.id, certificates.journeyId))
      .leftJoin(sessions, eq(sessions.id, courses.sessionId))
      .innerJoin(users, eq(users.id, certificates.userId))
      .innerJoin(
        organizations,
        eq(organizations.id, certificates.organizationId),
      )
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
        journeyName: journeys.title,
        certificateCode: certificates.certificateCode,
        issuedAt: certificates.issuedAt,
        finalScore: certificates.finalScore,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .leftJoin(courses, eq(courses.id, certificates.courseId))
      .leftJoin(journeys, eq(journeys.id, certificates.journeyId))
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
        journeyName: journeys.title,
        issuedAt: certificates.issuedAt,
        isRevoked: certificates.isRevoked,
      })
      .from(certificates)
      .leftJoin(courses, eq(courses.id, certificates.courseId))
      .leftJoin(journeys, eq(journeys.id, certificates.journeyId))
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
        journeyId: certificates.journeyId,
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
