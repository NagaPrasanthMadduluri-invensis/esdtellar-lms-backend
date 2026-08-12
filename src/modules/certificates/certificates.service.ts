import { createHash, randomBytes } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

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
  async autoIssue(userId: number, courseId: number): Promise<number | null> {
    try {
      const existing = await this.repository.findByUserAndCourse(
        userId,
        courseId,
      );
      if (existing) return null;

      const snapshot = await this.repository.getCompletionSnapshot(
        userId,
        courseId,
      );
      const verdict = this.evaluate(snapshot);
      if (!verdict.complete) return null;

      return await this.repository.insert({
        userId,
        courseId,
        certificateCode: this.generateCode(courseId, userId),
        issuedAt: new Date().toISOString(),
        finalScore: verdict.finalScore,
      });
    } catch (error) {
      // A race on UNIQUE(user_id, course_id) or a transient Turso error must
      // not fail the lesson/assessment flow that triggered this.
      this.logger.warn(
        `Auto-issue skipped for user=${userId} course=${courseId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async listForLearner(userId: number) {
    const rows = await this.repository.listForLearner(userId);
    return rows.map((row) => ({
      id: row.id,
      certificateCode: row.certificateCode,
      courseName: row.courseName,
      issuedAt: row.issuedAt,
      finalScore: row.finalScore,
      isRevoked: row.isRevoked === 1,
    }));
  }

  async getForLearner(id: number, userId: number) {
    const row = await this.repository.findDetailById(id);
    if (!row) throw new NotFoundException('Certificate not found');
    if (row.userId !== userId) throw new ForbiddenException('Forbidden');

    return {
      id: row.id,
      certificateCode: row.certificateCode,
      learnerName: `${row.firstName} ${row.lastName}`,
      courseName: row.courseName,
      issuedAt: row.issuedAt,
      finalScore: row.finalScore,
      isRevoked: row.isRevoked === 1,
    };
  }

  async listForAdmin(filters: { userId?: number; courseId?: number }) {
    const rows = await this.repository.listForAdmin(filters);
    return rows.map((row) => ({
      id: row.id,
      learnerName: `${row.firstName} ${row.lastName}`,
      courseName: row.courseName,
      certificateCode: row.certificateCode,
      issuedAt: row.issuedAt,
      finalScore: row.finalScore,
      isRevoked: row.isRevoked === 1,
    }));
  }

  async revoke(id: number, adminId: number): Promise<void> {
    const cert = await this.repository.findStatusById(id);
    if (!cert) throw new NotFoundException('Certificate not found');
    await this.repository.revoke(id, adminId);
  }

  /** Re-stamps a revoked certificate with a fresh code and issue date. */
  async reinstate(id: number) {
    const cert = await this.repository.findStatusById(id);
    if (!cert) throw new NotFoundException('Certificate not found');
    if (cert.isRevoked === 0) {
      throw new ConflictException('Certificate is not revoked');
    }

    const certificateCode = this.generateCode(cert.courseId, cert.userId);
    const issuedAt = new Date().toISOString();
    await this.repository.reinstate(id, certificateCode, issuedAt);

    return { id, certificateCode, issuedAt, isRevoked: false };
  }

  /**
   * Public lookup. Returns course name, issue date and validity only — no
   * learner name, email or employee id. Unknown codes return the same shape
   * with `valid: false` rather than a 404, so the endpoint cannot be used to
   * probe which codes exist.
   */
  async verify(code: string) {
    const row = await this.repository.findByCodeForVerification(code);
    if (!row) {
      return {
        valid: false,
        courseName: null,
        issuedAt: null,
        isRevoked: null,
      };
    }

    const isRevoked = row.isRevoked === 1;
    return {
      valid: !isRevoked,
      courseName: row.courseName,
      issuedAt: row.issuedAt,
      isRevoked,
    };
  }
}
