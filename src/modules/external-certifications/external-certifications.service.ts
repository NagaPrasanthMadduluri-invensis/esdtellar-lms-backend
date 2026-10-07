import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  ALLOWED_CERTIFICATE_TYPES,
  CERTIFICATE_MAX_BYTES,
  EXTERNAL_CERT_STATUS_LABELS,
  type ExternalCertStatus,
} from '@/common/external-certifications';
import { actorLabel } from '@/common/notifications';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import { ActivityService } from '@/modules/activity/activity.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import { CertificateFileService } from './certificate-file.service';
import type {
  DecideExternalCertificationDto,
  SubmitExternalCertificationDto,
} from './dto/external-certification.dto';
import {
  ExternalCertificationsRepository,
  type ExternalCertRow,
} from './external-certifications.repository';

/**
 * External certifications: the claim, the two decisions, and what an
 * approval creates.
 *
 * NOTHING EXISTS UNTIL THE FINAL APPROVAL. A submitted claim writes one row
 * and a file and touches nothing else — no course, no assignment, no
 * completion, no hours, no learning path. That is the requirement stated as
 * an implementation: a learner cannot move their own numbers by filling in
 * a form, and a claim sitting in a queue is visible to its approvers and to
 * nobody else's figures.
 */
@Injectable()
export class ExternalCertificationsService {
  constructor(
    private readonly repository: ExternalCertificationsRepository,
    private readonly files: CertificateFileService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
  ) {}

  /* ───────────────────────────── Learner ─────────────────────────────── */

  /**
   * File a claim.
   *
   * The manager is resolved HERE and stored on the row, so the trail says
   * who was actually asked. When the learner has none — or theirs has been
   * deactivated — the row starts at `pending_admin` and the response says
   * so, because a learner who is told "sent to your manager" and has no
   * manager is watching a queue that will never move.
   */
  async submit(
    scope: OrgScope,
    user: AuthenticatedUser,
    dto: SubmitExternalCertificationDto,
    file: Express.Multer.File | undefined,
  ) {
    const stored = await this.storeFile(file);

    const manager = await this.repository.activeManagerOf(scope, user.userId);
    const status: ExternalCertStatus = manager
      ? 'pending_manager'
      : 'pending_admin';

    // Hours in, minutes stored — one unit in the database (0036's header).
    const minutes = Math.round(dto.course_hours * 60);

    let id: number;
    try {
      id = await this.repository.create({
        scope,
        userId: user.userId,
        nameOnCertificate: dto.name_on_certificate,
        courseName: dto.course_name,
        courseMinutes: minutes,
        authorizedBody: dto.authorized_body,
        filePath: stored.path,
        fileName: stored.name,
        fileMime: stored.mime,
        fileSizeBytes: stored.size,
        managerUserId: manager?.id ?? null,
        status,
      });
    } catch (error) {
      // The bytes are on disk and the row is not. Drop the file rather than
      // leave debris nothing references — the same rollback the lesson
      // editor does for a SCORM package it uploaded (§10.9).
      await this.files.discard(stored.path);
      throw error;
    }

    void this.announceSubmission(scope, user, {
      id,
      courseName: dto.course_name,
      managerId: manager?.id ?? null,
      status,
    });

    void this.activity.record(scope, {
      type: 'external_certification_submitted',
      detail: `Submitted an external certification: "${dto.course_name}"`,
      actor: user,
      subjectType: 'external_certification',
      subjectId: id,
    });

    return {
      certification: this.shape(
        (await this.repository.findById(scope, id)) as ExternalCertRow,
      ),
      /*
       * Said back on submit rather than left to be worked out from a chip.
       * The two paths genuinely differ in how many people have to act, and
       * a learner should not have to compare their status against somebody
       * else's to notice they are on the shorter one.
       */
      sent_to: manager
        ? `${manager.name}, your manager. Your L&D team has also been told.`
        : 'your L&D team — there is no manager on your record, so this needs one approval rather than two.',
    };
  }

  async listForLearner(scope: OrgScope, userId: number) {
    const rows = await this.repository.listForLearner(scope, userId);
    return { certifications: rows.map((r) => this.shape(r)) };
  }

  /* ───────────────────────────── Manager ─────────────────────────────── */

  async listForManager(scope: OrgScope, managerUserId: number) {
    const rows = await this.repository.listForManager(scope, managerUserId);
    return { certifications: rows.map((r) => this.shape(r)) };
  }

  /**
   * The manager's decision: did this person really do it?
   *
   * Only the manager the row was SENT to may act, not whoever happens to
   * manage the learner now — a reporting line that changed mid-flight must
   * not hand somebody else's decision to a new desk.
   */
  async decideAsManager(
    scope: OrgScope,
    manager: AuthenticatedUser,
    id: number,
    dto: DecideExternalCertificationDto,
  ) {
    const row = await this.repository.findById(scope, id);
    if (!row) throw new NotFoundException('Certification not found');

    if (row.manager_user_id !== manager.userId) {
      throw new ForbiddenException('This is not yours to approve');
    }
    if (row.status !== 'pending_manager') {
      throw new UnprocessableEntityException(
        `This has already moved on — it is ${EXTERNAL_CERT_STATUS_LABELS[row.status as ExternalCertStatus] ?? row.status}.`,
      );
    }
    this.assertReasonGiven(dto);

    const status: ExternalCertStatus = dto.approve
      ? 'pending_admin'
      : 'rejected';
    await this.repository.recordManagerDecision(scope, id, {
      status,
      decidedBy: manager.userId,
      note: dto.note ?? null,
    });

    if (dto.approve) {
      // L&D were told at submission; this is the moment they can act, which
      // is a different message and worth a second one.
      void this.notifications.notify({
        userIds: await this.notifications.adminsOf(scope.organizationId),
        organizationId: scope.organizationId,
        type: 'external_cert_ready',
        title: `"${row.course_name}" needs your final approval`,
        body: `${row.learner_name} submitted it and ${actorLabel(manager)} has confirmed they completed it.`,
        link: '/admin/certificates',
        subjectType: 'external_certification',
        subjectId: id,
        actorName: actorLabel(manager),
        exceptUserId: manager.userId,
      });
    }

    void this.tellLearner(scope, row, {
      approved: dto.approve,
      finalStep: false,
      note: dto.note ?? null,
      actor: manager,
    });

    return { certification: this.shape((await this.repository.findById(scope, id))!) };
  }

  /* ────────────────────────────── Admin ──────────────────────────────── */

  async listForAdmin(
    scope: OrgScope,
    filters: { status?: string; limit: number; offset: number },
  ) {
    const [rows, total, counts] = await Promise.all([
      this.repository.listForAdmin(
        scope,
        filters.status,
        filters.limit,
        filters.offset,
      ),
      this.repository.countForAdmin(scope, filters.status),
      this.repository.statusCounts(scope),
    ]);
    return {
      certifications: rows.map((r) => this.shape(r)),
      total,
      counts: {
        pending_manager: counts.pending_manager ?? 0,
        pending_admin: counts.pending_admin ?? 0,
        approved: counts.approved ?? 0,
        rejected: counts.rejected ?? 0,
      },
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /**
   * The final decision, and the only place anything is created.
   *
   * An approval writes a companion course, its module, its lesson, the
   * assignment and the completion in ONE statement (§10.7's pattern), so
   * the learner's hours and their completed count move through definitions
   * that already work rather than through a second code path.
   *
   * It is deliberately NOT reachable while the manager still has it: an
   * admin who wants to short-circuit that has to reject or wait, because a
   * two-step approval an admin can skip is a one-step approval with extra
   * words.
   */
  async decideAsAdmin(
    scope: OrgScope,
    admin: AuthenticatedUser,
    id: number,
    dto: DecideExternalCertificationDto,
  ) {
    const row = await this.repository.findById(scope, id);
    if (!row) throw new NotFoundException('Certification not found');

    if (row.status === 'pending_manager') {
      throw new UnprocessableEntityException(
        `${row.manager_name || 'Their manager'} has not confirmed this yet. It reaches you once they do.`,
      );
    }
    if (row.status !== 'pending_admin') {
      throw new UnprocessableEntityException(
        `This has already been decided — it is ${EXTERNAL_CERT_STATUS_LABELS[row.status as ExternalCertStatus] ?? row.status}.`,
      );
    }
    this.assertReasonGiven(dto);

    let courseId: number | null = null;
    if (dto.approve) {
      courseId = await this.repository.createCompanionCourse({
        scope,
        certificationId: id,
        userId: row.user_id,
        approvedBy: admin.userId,
        courseName: row.course_name,
        authorizedBody: row.authorized_body,
        minutes: row.course_minutes,
      });
    }

    await this.repository.recordAdminDecision(scope, id, {
      status: dto.approve ? 'approved' : 'rejected',
      decidedBy: admin.userId,
      note: dto.note ?? null,
      courseId,
    });

    void this.tellLearner(scope, row, {
      approved: dto.approve,
      finalStep: true,
      note: dto.note ?? null,
      actor: admin,
    });

    void this.activity.record(scope, {
      type: dto.approve
        ? 'external_certification_approved'
        : 'external_certification_rejected',
      detail: `${dto.approve ? 'Approved' : 'Declined'} ${row.learner_name}'s external certification "${row.course_name}"`,
      actor: admin,
      subjectType: 'external_certification',
      subjectId: id,
    });

    return { certification: this.shape((await this.repository.findById(scope, id))!) };
  }

  /* ─────────────────────────────── File ──────────────────────────────── */

  /**
   * The uploaded document, for whoever is entitled to see it.
   *
   * Ownership is checked HERE rather than by a guard (§5.3), because the
   * three audiences are not three roles: the OWNER, the manager the row was
   * sent to, and any admin of the learner's organization. A trainer, another
   * learner, or a manager the row was never sent to gets 403 — the row
   * exists, it is simply not theirs.
   */
  async fileFor(scope: OrgScope, user: AuthenticatedUser, id: number) {
    const row = await this.repository.findFile(scope, id);
    if (!row) throw new NotFoundException('Certification not found');

    const isOwner = row.user_id === user.userId;
    const isTheirManager = row.manager_user_id === user.userId;
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isTheirManager && !isAdmin) {
      throw new ForbiddenException('This certificate is not yours to view');
    }

    return {
      stream: this.files.open(row.file_path),
      fileName: row.file_name,
      mime: row.file_mime,
    };
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  /**
   * Three checks on the upload, in the order that gives the best message,
   * and the third is the one that matters: a multipart Content-Type is
   * written by the client, so without checking the bytes an HTML file
   * labelled `application/pdf` would be stored and later streamed back with
   * that type. §10.10 records the same reasoning for thumbnails.
   */
  private async storeFile(file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException(
        'file: attach a copy of the certificate — a PDF or a photo of it.',
      );
    }

    const mime = (file.mimetype || '').toLowerCase();
    if (!(ALLOWED_CERTIFICATE_TYPES as readonly string[]).includes(mime)) {
      throw new UnprocessableEntityException(
        `file: ${file.originalname || 'that file'} is not a supported format. Upload a PDF, JPG, PNG or WebP.`,
      );
    }
    if (file.size > CERTIFICATE_MAX_BYTES) {
      throw new UnprocessableEntityException(
        `file: the certificate is ${Math.round(file.size / 1024 / 1024)} MB, over the ${Math.round(CERTIFICATE_MAX_BYTES / 1024 / 1024)} MB limit.`,
      );
    }
    if (sniffType(file.buffer) !== mime) {
      throw new UnprocessableEntityException(
        `file: ${file.originalname || 'that file'} is not a valid ${mime.split('/')[1].toUpperCase()}.`,
      );
    }

    const path = await this.files.save(file.buffer, mime);
    return {
      path,
      name: (file.originalname || 'certificate').slice(0, 200),
      mime,
      size: file.size,
    };
  }

  /** A refusal without a reason leaves the learner with nothing to do next. */
  private assertReasonGiven(dto: DecideExternalCertificationDto) {
    if (!dto.approve && !dto.note) {
      throw new UnprocessableEntityException(
        'note: say why this was not approved — the learner sees this, and a refusal with no reason gives them nothing to act on.',
      );
    }
  }

  private shape(row: ExternalCertRow) {
    return {
      id: row.id,
      user_id: row.user_id,
      learner_name: row.learner_name || row.learner_email,
      learner_email: row.learner_email,
      department: row.department,
      name_on_certificate: row.name_on_certificate,
      course_name: row.course_name,
      /** Back out to hours for display — the form's unit, and the
       *  certificate's. Minutes stay the stored one. */
      course_hours: Math.round((row.course_minutes / 60) * 100) / 100,
      course_minutes: row.course_minutes,
      authorized_body: row.authorized_body,
      file_name: row.file_name,
      file_mime: row.file_mime,
      file_size_bytes: row.file_size_bytes,
      status: row.status,
      status_label:
        EXTERNAL_CERT_STATUS_LABELS[row.status as ExternalCertStatus] ??
        row.status,
      manager_user_id: row.manager_user_id,
      manager_name: row.manager_name || null,
      manager_decided_at: toIso(row.manager_decided_at),
      manager_note: row.manager_note,
      admin_decided_at: toIso(row.admin_decided_at),
      admin_note: row.admin_note,
      course_id: row.course_id,
      submitted_at: toIso(row.created_at),
    };
  }

  private async announceSubmission(
    scope: OrgScope,
    learner: AuthenticatedUser,
    input: {
      id: number;
      courseName: string;
      managerId: number | null;
      status: ExternalCertStatus;
    },
  ) {
    const body = `${actorLabel(learner)} is asking for "${input.courseName}" to be counted.`;

    if (input.managerId) {
      await this.notifications.notify({
        userIds: [input.managerId],
        organizationId: scope.organizationId,
        type: 'external_cert_submitted',
        title: 'An external certification needs your confirmation',
        body,
        link: '/team-learning',
        subjectType: 'external_certification',
        subjectId: input.id,
        actorName: actorLabel(learner),
      });
    }

    // L&D are told at submission even when a manager has it first, because
    // the requirement is that both know — and because an admin seeing it
    // early is how a claim stuck behind an absent manager gets noticed.
    await this.notifications.notify({
      userIds: await this.notifications.adminsOf(scope.organizationId),
      organizationId: scope.organizationId,
      type: 'external_cert_submitted',
      title: 'New external certification submitted',
      body: input.managerId
        ? `${body} Their manager has it first.`
        : `${body} They have no manager, so it is with you.`,
      link: '/admin/certificates',
      subjectType: 'external_certification',
      subjectId: input.id,
      actorName: actorLabel(learner),
    });
  }

  private async tellLearner(
    scope: OrgScope,
    row: ExternalCertRow,
    input: {
      approved: boolean;
      finalStep: boolean;
      note: string | null;
      actor: AuthenticatedUser;
    },
  ) {
    // A manager's yes is not an outcome — it is a step. Saying "approved"
    // there would have the learner believing their hours had moved when
    // nothing had been created yet.
    const title = !input.approved
      ? `"${row.course_name}" was not approved`
      : input.finalStep
        ? `"${row.course_name}" has been approved`
        : `"${row.course_name}" passed your manager's review`;

    const body = !input.approved
      ? (input.note ?? 'Speak to your L&D team if you think this is a mistake.')
      : input.finalStep
        ? `It is in My Courses as completed externally, and its hours are in your total.`
        : 'Your L&D team has the final approval.';

    await this.notifications.notify({
      userIds: [row.user_id],
      organizationId: scope.organizationId,
      // Three outcomes, three types: the manager's confirmation is a step and
      // must not borrow the approval's "it now counts" closing line.
      type: !input.approved
        ? 'external_cert_rejected'
        : input.finalStep
          ? 'external_cert_approved'
          : 'external_cert_confirmed',
      title,
      body,
      link: '/certifications',
      subjectType: 'external_certification',
      subjectId: row.id,
      actorName: actorLabel(input.actor),
      exceptUserId: input.actor.userId,
    });
  }
}

/**
 * The type the bytes themselves declare, or null. A sanity check on the
 * declared Content-Type, not a format parser — the same short-signature
 * approach `sniffImageType` takes in `MediaService`.
 */
function sniffType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Postgres timestamps carry a space and a `+00` that `new Date()` rejects
 *  (§10.3.1.15), so every date this module sends is converted here. */
function toIso(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value.replace(' ', 'T').replace(/\+(\d\d)$/, '+$1:00'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}
