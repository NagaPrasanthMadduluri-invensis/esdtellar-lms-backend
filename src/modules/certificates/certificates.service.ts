import { createHash, randomBytes } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';

import {
  CertificatesRepository,
  type CompletionSnapshot,
} from './certificates.repository';

export type IneligibleReason =
  | 'no_lessons'
  | 'incomplete'
  | 'assessment_not_passed';

export interface CompletionVerdict {
  complete: boolean;
  reason: IneligibleReason | null;
  finalScore: number | null;
}

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(private readonly repository: CertificatesRepository) {}

  /**
   * Server-side only. A client-supplied code is never accepted anywhere —
   * the code is the thing the public verify endpoint trusts.
   */
  generateCode(courseId: number, userId: number): string {
    const shorthash = createHash('sha256')
      .update(
        `${courseId}:${userId}:${Date.now()}:${randomBytes(8).toString('hex')}`,
      )
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();

    return `EDS-${courseId}-${userId}-${shorthash}`;
  }

  /**
   * A journey certificate's code — same hash construction as `generateCode`,
   * with the `J` (and the journey id in the `J<id>` slot rather than a course
   * id) so the two are tellable apart by eye in a support ticket (§3.4).
   */
  generateJourneyCode(journeyId: number, userId: number): string {
    const shorthash = createHash('sha256')
      .update(
        `J${journeyId}:${userId}:${Date.now()}:${randomBytes(8).toString('hex')}`,
      )
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();

    return `EDS-J${journeyId}-${userId}-${shorthash}`;
  }

  /**
   * Single source of truth for "has this learner earned a certificate?".
   *
   * A course is certifiable when every active lesson is complete AND, if the
   * course has an ACTIVE assessment, a passing attempt exists. Retired
   * assessments (is_active = 0) do not gate issuance — a deliberate divergence
   * from the legacy course-progress query, signed off in specs/certificates.md.
   */
  evaluate(snapshot: CompletionSnapshot): CompletionVerdict {
    const { totalLessons, completedLessons, hasAssessment, hasPassed } =
      snapshot;

    if (totalLessons === 0) {
      return { complete: false, reason: 'no_lessons', finalScore: null };
    }

    const percent = Math.round((completedLessons / totalLessons) * 100);
    if (percent < 100) {
      return { complete: false, reason: 'incomplete', finalScore: null };
    }

    if (hasAssessment && !hasPassed) {
      return {
        complete: false,
        reason: 'assessment_not_passed',
        finalScore: null,
      };
    }

    return {
      complete: true,
      reason: null,
      finalScore: hasAssessment ? snapshot.bestScore : null,
    };
  }

  /**
   * Best-effort issuance, called the moment a learner finishes a course.
   *
   * MUST NOT throw into the caller: a certificate failure cannot break marking
   * a lesson complete or submitting an assessment. Skips when ANY certificate
   * row exists for (user, course) — including a revoked one — so auto-issue
   * never overturns an admin revocation.
   *
   * Returns the new certificate id, or null when nothing was issued.
   */
  async autoIssue(
    scope: OrgScope,
    userId: number,
    courseId: number,
  ): Promise<number | null> {
    try {
      const existing = await this.repository.findByUserAndCourse(
        scope,
        userId,
        courseId,
      );
      if (existing) return null;

      const snapshot = await this.repository.getCompletionSnapshot(
        scope,
        userId,
        courseId,
      );

      // A live/offline session's training never auto-issues. Its single lesson
      // is completed for the learner by the admin marking the session done, so
      // auto-issue would mint a certificate for merely turning up. Certificates
      // for sessions are the admin's own call, through issueManually().
      if (snapshot.sessionId !== null) return null;

      const verdict = this.evaluate(snapshot);
      if (!verdict.complete) return null;

      // `certificates` is an activity table — it takes the learner's org,
      // which is exactly what `scope` is here: the caller is the learner
      // completing their own lesson/assessment.
      return await this.repository.insert(scope, {
        userId,
        courseId,
        certificateCode: this.generateCode(courseId, userId),
        issuedAt: new Date().toISOString(),
        finalScore: verdict.finalScore,
      });
    } catch (error) {
      // A race on UNIQUE(user_id, course_id) or a transient database error must
      // not fail the lesson/assessment flow that triggered this.
      this.logger.warn(
        `Auto-issue skipped for user=${userId} course=${courseId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Best-effort issuance for a completed journey (spec §3.4, §4.2), called by
   * `JourneysService.onCourseProgress` the moment every required course in the
   * journey is complete for this learner.
   *
   * Unlike `autoIssue`, this does NOT re-evaluate completion itself — the
   * caller has already decided the journey is complete against the one
   * definition of "complete" (§4.1), and re-deriving it here would be a
   * second one. It only guards against a duplicate: ANY certificate row for
   * (user, journey), including a revoked one, means this is a replay and
   * nothing is issued (mirrors `autoIssue`'s own rule for a course).
   *
   * MUST NOT throw into the caller (§8.4) — a certificate failure cannot
   * break marking a lesson complete. A journey has no assessment of its own,
   * so `finalScore` is always null.
   *
   * Returns the new certificate id, or null when nothing was issued.
   */
  async issueForJourney(
    scope: OrgScope,
    userId: number,
    journeyId: number,
  ): Promise<number | null> {
    try {
      const existing = await this.repository.findByUserAndJourney(
        scope,
        userId,
        journeyId,
      );
      if (existing) return null;

      return await this.repository.insertJourney(scope, {
        userId,
        journeyId,
        certificateCode: this.generateJourneyCode(journeyId, userId),
        issuedAt: new Date().toISOString(),
        finalScore: null,
      });
    } catch (error) {
      this.logger.warn(
        `Journey certificate issuance skipped for user=${userId} journey=${journeyId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Admin-issued certificate.
   *
   * Deliberately does NOT require completion. Auto-issue already covers the
   * learner who finished in the system; this exists for the cases it cannot
   * see — training completed offline, a migrated record, or an auto-issue that
   * was missed while storage or the database was misbehaving. The completion
   * state is returned so the admin can see what they overrode rather than
   * finding out later.
   *
   * A revoked certificate for the same learner and course is reinstated rather
   * than duplicated, because UNIQUE(user_id, course_id) means there can only
   * ever be one.
   *
   * This is also the ONLY route to a certificate for a session's training:
   * auto-issue declines those on purpose (see autoIssue).
   */
  async issueManually(
    scope: OrgScope,
    userId: number,
    courseId: number,
    adminId: number,
  ) {
    const learner = await this.repository.findLearner(scope, userId);
    if (!learner) throw new NotFoundException('Learner not found');

    const course = await this.repository.findCourse(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');

    const snapshot = await this.repository.getCompletionSnapshot(
      scope,
      userId,
      courseId,
    );
    const verdict = this.evaluate(snapshot);

    const existing = await this.repository.findByUserAndCourse(
      scope,
      userId,
      courseId,
    );
    if (existing) {
      if (existing.isRevoked === 0) {
        throw new ConflictException(
          'This learner already has a certificate for this course.',
        );
      }
      const reinstated = await this.reinstate(scope, existing.id);
      return { ...reinstated, reinstated: true, hadCompleted: verdict.complete };
    }

    const id = await this.repository.insert(scope, {
      userId,
      courseId,
      certificateCode: this.generateCode(courseId, userId),
      issuedAt: new Date().toISOString(),
      finalScore: verdict.finalScore,
    });

    this.logger.log(
      `Certificate ${id} issued manually by admin=${adminId} for user=${userId} ` +
        `course=${courseId} (completed=${verdict.complete})`,
    );

    return {
      id,
      userId,
      courseId,
      isRevoked: false,
      reinstated: false,
      // false means the admin granted it to someone the system does not
      // consider finished — worth surfacing, not hiding.
      hadCompleted: verdict.complete,
    };
  }

  /** `journeyName` is additive — set only on a `J`-code row (§5). */
  async listForLearner(scope: OrgScope, userId: number) {
    const rows = await this.repository.listForLearner(scope, userId);
    return rows.map((row) => ({
      id: row.id,
      certificateCode: row.certificateCode,
      courseName: row.courseName,
      journeyName: row.journeyName,
      issuedAt: row.issuedAt,
      finalScore: row.finalScore,
      isRevoked: row.isRevoked === 1,
    }));
  }

  async getForLearner(scope: OrgScope, id: number, userId: number) {
    const row = await this.repository.findDetailById(scope, id);
    if (!row) throw new NotFoundException('Certificate not found');
    if (row.userId !== userId) throw new ForbiddenException('Forbidden');

    return {
      id: row.id,
      certificateCode: row.certificateCode,
      learnerName: `${row.firstName} ${row.lastName}`,
      courseName: row.courseName,
      journeyName: row.journeyName,
      issuedAt: row.issuedAt,
      finalScore: row.finalScore,
      isRevoked: row.isRevoked === 1,
    };
  }

  async listForAdmin(
    scope: OrgScope,
    filters: { userId?: number; courseId?: number },
  ) {
    const rows = await this.repository.listForAdmin(scope, filters);
    return rows.map((row) => ({
      id: row.id,
      learnerName: `${row.firstName} ${row.lastName}`,
      courseName: row.courseName,
      journeyName: row.journeyName,
      certificateCode: row.certificateCode,
      issuedAt: row.issuedAt,
      finalScore: row.finalScore,
      isRevoked: row.isRevoked === 1,
    }));
  }

  async revoke(scope: OrgScope, id: number, adminId: number): Promise<void> {
    const cert = await this.repository.findStatusById(scope, id);
    if (!cert) throw new NotFoundException('Certificate not found');
    await this.repository.revoke(scope, id, adminId);
  }

  /** Re-stamps a revoked certificate with a fresh code and issue date. */
  async reinstate(scope: OrgScope, id: number) {
    const cert = await this.repository.findStatusById(scope, id);
    if (!cert) throw new NotFoundException('Certificate not found');
    if (cert.isRevoked === 0) {
      throw new ConflictException('Certificate is not revoked');
    }

    // Exactly one of the two is set (§3.4's CHECK constraint) — the journey
    // code format is picked the same way `verify()` tells the two apart.
    const certificateCode =
      cert.journeyId !== null
        ? this.generateJourneyCode(cert.journeyId, cert.userId)
        : this.generateCode(cert.courseId, cert.userId);
    const issuedAt = new Date().toISOString();
    await this.repository.reinstate(scope, id, certificateCode, issuedAt);

    return { id, certificateCode, issuedAt, isRevoked: false };
  }

  /**
   * Public lookup. Returns course (or journey) name, issue date and validity
   * only — no learner name, email or employee id. Unknown codes return the
   * same shape with `valid: false` rather than a 404, so the endpoint cannot
   * be used to probe which codes exist. `journeyName` is additive: a `J` code
   * carries it and a NULL `courseName`, a course code the reverse (§5).
   */
  async verify(code: string) {
    const row = await this.repository.findByCodeForVerification(code);
    if (!row) {
      return {
        valid: false,
        courseName: null,
        journeyName: null,
        issuedAt: null,
        isRevoked: null,
      };
    }

    const isRevoked = row.isRevoked === 1;
    return {
      valid: !isRevoked,
      courseName: row.courseName,
      journeyName: row.journeyName,
      issuedAt: row.issuedAt,
      isRevoked,
    };
  }
}
