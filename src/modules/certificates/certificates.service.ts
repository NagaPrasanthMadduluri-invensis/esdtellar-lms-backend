
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import * as QRCode from 'qrcode';

import type { OrgScope } from '@/database/org-scope';
import { buildCertificateCode } from '@/common/certificate-branding';
import { ActivityService } from '@/modules/activity/activity.service';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { NotificationsService } from '@/modules/notifications/notifications.service';

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

  constructor(
    private readonly repository: CertificatesRepository,
    /** Best-effort (§8.4) — `record` never throws. */
    private readonly activity: ActivityService,
    /** Best-effort (§8.4) — `notify` cannot throw. */
    private readonly notifications: NotificationsService,
    /** For the canonical UI origin the verify QR/link is built from. */
    private readonly config: ConfigService,
  ) {}

  /**
   * A fresh, unique certificate code — server-side only (a client-supplied
   * code is never accepted; the code is what the public verify endpoint trusts).
   *
   * ## Short codes, so uniqueness is guaranteed by RETRY, not by entropy
   *
   * The code is `<org-prefix><random hex>`, ten characters for a 3-4 letter
   * prefix (`EDSA2F9BD3`). That is short enough to read aloud and type, and too
   * short to lean on the hash for uniqueness the way the old 16-char code did.
   * So `certificate_code` (UNIQUE NOT NULL) is protected by a generate-check
   * loop: on the rare clash we mint another. Bounded, so a misconfiguration
   * (e.g. a tiny exhausted space) fails loudly rather than looping forever.
   *
   * The kind (course / path / session) is NOT encoded — it is derived from the
   * row (`journey_id`, `courses.session_id`), so one format serves all three.
   */
  private async generateUniqueCode(scope: OrgScope): Promise<string> {
    const prefix = await this.repository.findCertificatePrefix(scope);
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = buildCertificateCode(prefix);
      if (!(await this.repository.codeExists(code))) return code;
    }
    throw new Error('Could not allocate a unique certificate code');
  }

  /** The public scan-to-verify URL for a code, on the canonical UI origin. */
  verifyUrl(code: string): string {
    const origin = (
      this.config.get<string>('clientOrigin') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    return `${origin}/verify/${encodeURIComponent(code)}`;
  }

  /** A self-contained PNG data URL of the verify QR, embedded straight into the
   *  certificate document (which is printed and saved, so it cannot fetch). */
  private async qrDataUrl(code: string): Promise<string | null> {
    try {
      return await QRCode.toDataURL(this.verifyUrl(code), {
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      });
    } catch {
      return null; // a missing QR must never block showing the certificate
    }
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

      // Nor does an approved EXTERNAL certification (0036). The learner
      // already holds a certificate for it — the awarding body's — and
      // issuing one here would put this product's name on training it did
      // not deliver. Its companion lesson is completed the moment an admin
      // approves, so without this every approval would mint one.
      if (snapshot.externalCertificationId !== null) return null;

      const verdict = this.evaluate(snapshot);
      if (!verdict.complete) return null;

      // `certificates` is an activity table — it takes the learner's org,
      // which is exactly what `scope` is here: the caller is the learner
      // completing their own lesson/assessment.
      // Held in a variable because the email quotes it back to the learner.
      const code = await this.generateUniqueCode(scope);
      const certificateId = await this.repository.insert(scope, {
        userId,
        courseId,
        certificateCode: code,
        issuedAt: new Date().toISOString(),
        finalScore: verdict.finalScore,
      });

      /*
       * Two notifications, because two different things just happened and the
       * learner cares about both: they finished the course, and they have a
       * certificate for it.
       *
       * This is the right place for "course completed" precisely because of
       * the guard clauses above — `existing` makes it fire once and never on a
       * replay, and the completion verdict is the same definition the rest of
       * the product uses (§10.11). Putting it on the lesson-complete write
       * would fire on every lesson instead of on the last one.
       */
      void this.notifications.notify({
        userIds: [userId],
        organizationId: scope.organizationId,
        type: 'course_completed',
        title: `Course completed: ${snapshot.courseName ?? 'your course'}`,
        body:
          verdict.finalScore !== null
            ? `Final score ${verdict.finalScore}%. Well done.`
            : 'Well done.',
        link: '/my-courses',
        subjectType: 'course',
        subjectId: courseId,
        actorName: 'Edstellar',
      });

      void this.notifications.notify({
        userIds: [userId],
        organizationId: scope.organizationId,
        type: 'certificate_issued',
        title: 'Your certificate is ready',
        subjectName: snapshot.courseName ?? null,
        body: `You have completed ${snapshot.courseName ?? 'your course'} and your `
          + 'certificate is ready to download.',
        /*
         * The code is on the panel because it is the one thing the learner
         * may need to quote — it is what the public verification check
         * looks up, and it is printed on the document itself.
         */
        facts: [
          { label: 'Course', value: snapshot.courseName ?? '—' },
          { label: 'Certificate ID', value: code },
          {
            label: 'Verification',
            value: 'Quote the certificate ID — anyone can confirm it is genuine',
          },
        ],
        link: '/certifications',
        subjectType: 'certificate',
        subjectId: certificateId,
        actorName: 'Edstellar',
      });

      return certificateId;
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
        certificateCode: await this.generateUniqueCode(scope),
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
    actor?: AuthenticatedUser,
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
      certificateCode: await this.generateUniqueCode(scope),
      issuedAt: new Date().toISOString(),
      finalScore: verdict.finalScore,
    });

    this.logger.log(
      `Certificate ${id} issued manually by admin=${adminId} for user=${userId} ` +
        `course=${courseId} (completed=${verdict.complete})`,
    );

    await this.activity.record(scope, {
      type: 'certificate_issued',
      detail: `Issued "${course.name}" to learner #${userId}`,
      actor: actor ?? null,
      subjectType: 'certificate',
      subjectId: id,
    });

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
  /**
   * Which document a certificate is, decided ONCE here and sent down, so the
   * list chip, the document's wording and its details cannot disagree.
   *
   *   journey_id set           -> 'path'     Certificate of Achievement
   *   course is a session's    -> 'session'  Certificate of Attendance
   *   anything else            -> 'course'   Certificate of Completion
   *
   * A session certificate is only ever issued by hand (`issueManually`),
   * because auto-issue refuses session trainings (§10.7) — the trainer
   * marks attendance, an admin decides it merits a document.
   */
  private certificateKind(row: {
    journeyName: string | null;
    sessionId: number | null;
  }): 'course' | 'path' | 'session' {
    if (row.journeyName !== null) return 'path';
    if (row.sessionId !== null) return 'session';
    return 'course';
  }

  async listForLearner(scope: OrgScope, userId: number) {
    const rows = await this.repository.listForLearner(scope, userId);
    return rows.map((row) => ({
      id: row.id,
      certificateCode: row.certificateCode,
      courseName: row.courseName,
      journeyName: row.journeyName,
      kind: this.certificateKind(row),
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
      // The scan-to-verify link and a self-contained QR PNG, printed on the
      // document. The QR is a data URL so a saved/printed certificate carries
      // it with no network fetch.
      verifyUrl: this.verifyUrl(row.certificateCode),
      qrDataUrl: await this.qrDataUrl(row.certificateCode),
      learnerName: `${row.firstName} ${row.lastName}`,
      courseName: row.courseName,
      journeyName: row.journeyName,
      // The employer the certificate is issued under — printed where the
      // product name used to be. See the repository's note on why this is the
      // learner's org and not the course's author.
      organizationName: row.organizationName,
      // The tenant's own mark. Null is the normal case; the document falls
      // back to the built-in layered-diamond rather than leaving a gap.
      organizationLogoUrl: row.organizationLogoUrl ?? null,
      // Null means the document signs with the organisation's own name.
      signatoryName: row.signatoryName ?? null,
      signatoryTitle: row.signatoryTitle ?? null,
      issuedAt: row.issuedAt,
      finalScore: row.finalScore,
      isRevoked: row.isRevoked === 1,
      // The certificate document names the category and the course length
      // beside the issue date. Both are null on a journey certificate, which
      // has no single course behind it, and the document simply omits what
      // it does not have rather than printing a dash for a fact that does
      // not exist at that level.
      category: row.category ?? null,
      durationMinutes:
        row.durationMinutes === null || row.durationMinutes === undefined
          ? null
          : Number(row.durationMinutes),
      kind: this.certificateKind(row),
      // Present only for its own kind; null otherwise, so the document never
      // has to guess which block applies.
      path:
        this.certificateKind(row) === 'path'
          ? {
              tag: row.journeyTag ?? null,
              courses: row.pathCourses ?? [],
              durationMinutes:
                row.pathDurationMinutes === null ? null : Number(row.pathDurationMinutes),
              completedAt: row.pathCompletedAt ?? null,
            }
          : null,
      session:
        this.certificateKind(row) === 'session'
          ? {
              title: row.sessionTitle ?? row.courseName,
              // The stored enum is ILT / Virtual; the document says it in words.
              format: row.sessionType === 'Virtual' ? 'Virtual' : 'In person',
              mode: row.sessionType === 'Virtual' ? 'virtual' : 'ilt',
              // A virtual session's venue is its meeting link. That is never
              // printed: it is a credential to a call, it goes stale, and on
              // a document somebody keeps it would read as an address.
              venue:
                row.sessionType === 'Virtual'
                  ? 'Online'
                  : row.sessionVenue?.trim() || null,
              date: row.sessionDate ?? null,
              trainer: row.sessionTrainer ?? null,
            }
          : null,
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

  async revoke(
    scope: OrgScope,
    id: number,
    adminId: number,
    actor?: AuthenticatedUser,
  ): Promise<void> {
    const cert = await this.repository.findStatusById(scope, id);
    if (!cert) throw new NotFoundException('Certificate not found');
    await this.repository.revoke(scope, id, adminId);

    await this.activity.record(scope, {
      type: 'certificate_revoked',
      detail: `Revoked certificate #${id}`,
      actor: actor ?? null,
      subjectType: 'certificate',
      subjectId: id,
    });
  }

  /** Re-stamps a revoked certificate with a fresh code and issue date. */
  async reinstate(scope: OrgScope, id: number) {
    const cert = await this.repository.findStatusById(scope, id);
    if (!cert) throw new NotFoundException('Certificate not found');
    if (cert.isRevoked === 0) {
      throw new ConflictException('Certificate is not revoked');
    }

    // One format serves course and journey alike — the kind is derived from the
    // row, not parsed from the code, so a reissue just mints a fresh unique one.
    const certificateCode = await this.generateUniqueCode(scope);
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
      // Unknown codes return the same shape with `found: false` rather than a
      // 404, so the endpoint cannot be used to tell a real code from a typo.
      return {
        found: false,
        valid: false,
        certificateCode: code,
        kind: null,
        title: null,
        learnerName: null,
        organizationName: null,
        category: null,
        durationMinutes: null,
        issuedAt: null,
        isRevoked: null,
        session: null,
        pathTag: null,
      };
    }

    const kind = this.certificateKind(row);
    const isRevoked = row.isRevoked === 1;
    const title =
      kind === 'path' ? row.journeyName : row.courseName;

    return {
      found: true,
      valid: !isRevoked,
      certificateCode: row.certificateCode,
      kind,
      title,
      // The owner's decision (2026-10-23): a scan-to-verify page shows the
      // holder and issuer, because the QR is on a document they already present.
      learnerName: `${row.learnerFirstName} ${row.learnerLastName}`,
      organizationName: row.organizationName,
      category: row.category ?? null,
      durationMinutes:
        row.durationMinutes === null || row.durationMinutes === undefined
          ? null
          : Number(row.durationMinutes),
      issuedAt: row.issuedAt,
      isRevoked,
      pathTag: kind === 'path' ? (row.journeyTag ?? null) : null,
      session:
        kind === 'session'
          ? {
              format: row.sessionType === 'Virtual' ? 'Virtual' : 'In person',
              date: row.sessionDate ?? null,
              trainer: row.sessionTrainer ?? null,
            }
          : null,
    };
  }
}
