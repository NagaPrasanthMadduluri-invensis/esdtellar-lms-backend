import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { ActivityService } from '@/modules/activity/activity.service';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { MediaService } from '@/modules/media/media.service';

import type {
  MoveToBatchDto,
  RosterAddDto,
  SaveAttendanceDto,
  SessionBatchDto,
  SessionDto,
} from './dto/session.dto';
import { batchDisplayStatus } from '@/common/session-enrolment';
import { displayStatus } from './session-status.util';
import { SessionsRepository, type AttendanceRow } from './sessions.repository';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { actorLabel } from '@/common/notifications';

/** Attendance states that count as having taken the training. */
const CREDITING_STATUSES = ['present', 'late', 'partial'] as const;

/**
 * A session is a training assignment, not only a calendar event.
 *
 * Every session owns a companion course holding one lesson of
 * `content_type = 'session'` (see migration 0005). This service is what keeps
 * the two in step:
 *
 *   session created/edited  -> training course + lesson created/updated
 *   learner joins roster    -> user_course_assignments row  (the course card)
 *   learner leaves roster   -> assignment and any credit withdrawn
 *   admin marks completed   -> user_lesson_completions for those who attended
 *
 * Nothing downstream needed teaching about sessions as a result: My Courses,
 * progress, the dashboards, the leaderboard and learning hours all read
 * assignments and lesson completions already, so they pick a session up through
 * the same definitions they use for everything else.
 *
 * `scope` is first on every method here, matching the certificates module: it
 * is required, security-relevant, and every repository call below re-anchors
 * on it rather than trusting that a sibling call already checked.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly repository: SessionsRepository,
    private readonly media: MediaService,
    /** Best-effort (§8.4) — `record` never throws. */
    private readonly activity: ActivityService,
    /** Best-effort (§8.4) — `notify` cannot throw. */
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Puts the session's picture on its companion training course.
   *
   * The picture lives there rather than on `sessions` because the learner's
   * card for a session IS that course (§10.7) — storing it anywhere else would
   * mean a second column and a second place to render it. `CoursesService`
   * refuses edits to a session training, so this is the one writer.
   *
   * The three states are the ones §10.10 defines: an absent `thumbnail_url`
   * leaves the picture alone, null removes it, a string sets it. That matters
   * more here than on a course, because every other field on a session is
   * rewritten from the form on every save — without this, editing the venue
   * would delete the picture.
   */
  private async syncTrainingThumbnail(
    scope: OrgScope,
    sessionId: number,
    requested: string | null | undefined,
  ): Promise<void> {
    if (requested === undefined) return;

    const next = requested === null ? null : this.media.assertCourseThumbnail(requested);
    const previous = await this.repository.findTrainingThumbnail(scope, sessionId);
    if (previous === next) return;

    await this.repository.setTrainingThumbnail(scope, sessionId, next);
    // After the write, and best-effort (§8.4).
    await this.media.discardCourseThumbnail(previous);
  }

  async list(scope: OrgScope, archived = false) {
    const [rows, archivedCount] = (await Promise.all([
      this.repository.list(scope, archived),
      this.repository.archivedCount(scope),
    ])) as [Record<string, unknown>[], number];

    // Two more queries for the whole page, not two per card (§7.1). A list of
    // 40 sessions costs 4 round trips, not 81.
    const ids = rows.map((r) => Number(r.id));
    const [batches, waiting] = await Promise.all([
      this.repository.listBatchesForSessions(scope, ids),
      this.repository.waitlistCounts(scope, ids),
    ]);

    const batchesBySession = new Map<number, typeof batches>();
    for (const b of batches) {
      const list = batchesBySession.get(b.session_id);
      if (list) list.push(b);
      else batchesBySession.set(b.session_id, [b]);
    }
    const waitingBySession = new Map(waiting.map((w) => [w.session_id, Number(w.n)]));

    return {
      archived_count: archivedCount,
      sessions: rows.map((row) => ({
        ...row,
        course_id: row.course_id ? Number(row.course_id) : null,
        training_course_id: row.training_course_id
          ? Number(row.training_course_id)
          : null,
        capacity: Number(row.capacity),
        trainer_user_id: row.trainer_user_id ? Number(row.trainer_user_id) : null,
        roster_count: Number(row.roster_count ?? 0),
        attendance_marked_count: Number(row.marked_count ?? 0),
        credited_count: Number(row.credited_count ?? 0),
        display_status: displayStatus(row as Parameters<typeof displayStatus>[0]),
        enroll_mode: String(row.enroll_mode ?? 'assigned'),
        waitlist_count: waitingBySession.get(Number(row.id)) ?? 0,
        // Empty for a single-sitting session, which is the default and every
        // session that predates batches. The card reads the length to decide
        // whether to draw a segmented meter or a plain one.
        batches: (batchesBySession.get(Number(row.id)) ?? []).map((b) => ({
          ...b,
          capacity: b.capacity ?? Number(row.capacity ?? 0),
          roster_count: Number(b.roster_count),
          // Derived, never stored — a batch with no date yet is pending.
          display_status: batchDisplayStatus(b),
        })),
      })),
    };
  }

  /* ── Batches ─────────────────────────────────────────────────────────── */

  async createBatch(scope: OrgScope, sessionId: number, dto: SessionBatchDto) {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');

    const batchNo = await this.repository.nextBatchNo(scope, sessionId);
    const batch = await this.repository.createBatch({
      organizationId: scope.organizationId,
      sessionId,
      batchNo,
      label: dto.label ?? null,
      date: dto.date ?? null,
      startTime: dto.start_time ?? null,
      endTime: dto.end_time ?? null,
      capacity: dto.capacity ?? null,
      trainerUserId: dto.trainer_user_id ?? null,
    });
    return { batch };
  }

  async updateBatch(scope: OrgScope, batchId: number, dto: SessionBatchDto) {
    const existing = await this.repository.findBatch(scope, batchId);
    if (!existing) throw new NotFoundException('Batch not found');

    const batch = await this.repository.updateBatch(scope, batchId, {
      label: dto.label ?? null,
      date: dto.date ?? null,
      startTime: dto.start_time ?? null,
      endTime: dto.end_time ?? null,
      capacity: dto.capacity ?? null,
      trainerUserId: dto.trainer_user_id ?? null,
      status: dto.status ?? 'scheduled',
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return { batch };
  }

  async removeBatch(scope: OrgScope, batchId: number) {
    const existing = await this.repository.findBatch(scope, batchId);
    if (!existing) throw new NotFoundException('Batch not found');
    await this.repository.deleteBatch(scope, batchId);
    // Said back to the caller because it is the non-obvious half: the people
    // in that batch are still on the session, just unassigned to a sitting.
    return { message: 'Batch deleted. Its learners stay on the session, unassigned to a sitting.' };
  }

  /** Move a rostered learner between sittings. `batch_id: null` unassigns. */
  async setRosterBatch(
    scope: OrgScope,
    sessionId: number,
    dto: MoveToBatchDto,
  ) {
    if (dto.batch_id !== null && dto.batch_id !== undefined) {
      const batch = await this.repository.findBatch(scope, dto.batch_id);
      if (!batch || batch.session_id !== sessionId) {
        throw new NotFoundException('Batch not found on this session');
      }
    }
    const moved = await this.repository.setRosterBatch(
      scope,
      sessionId,
      dto.user_id,
      dto.batch_id ?? null,
    );
    if (moved === 0) throw new NotFoundException('That learner is not on this session');
    return { ok: true };
  }

  /* ── Waitlist ────────────────────────────────────────────────────────── */

  async waitlist(scope: OrgScope, sessionId: number) {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { waitlist: await this.repository.listWaitlist(scope, sessionId) };
  }

  /**
   * Promote somebody off the waitlist onto the roster.
   *
   * Goes through `addToRoster`, NOT a direct insert: adding someone to a
   * session's roster is what creates their `user_course_assignments` row and
   * so puts the training in their My Courses (§10.7). Writing the roster row
   * here by hand would enrol them in name only.
   *
   * The waitlist row is removed only AFTER the roster write succeeds — losing
   * their place in the queue to a failed enrolment is the worse outcome.
   */
  async promoteFromWaitlist(
    scope: OrgScope,
    sessionId: number,
    userId: number,
    adminUserId: number,
  ) {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');

    await this.addToRoster(scope, sessionId, adminUserId, { user_id: userId });
    await this.repository.removeFromWaitlist(scope, sessionId, userId);
    return { ok: true };
  }

  async removeFromWaitlist(scope: OrgScope, sessionId: number, userId: number) {
    const removed = await this.repository.removeFromWaitlist(scope, sessionId, userId);
    if (removed === 0) throw new NotFoundException('That learner is not on this waitlist');
    return { ok: true };
  }

  /**
   * Bulk cancel / archive / restore / delete from the list's selection bar.
   *
   * Delete goes through `remove()` per id rather than one statement, because
   * deleting a session is not a row delete: it cascades into the companion
   * training course, the roster and everybody's completion (§10.7), and
   * `remove()` is the one place that sequence is correct. Cancel and archive
   * are set-based (§7.1) because they touch only `sessions`.
   */
  async bulk(
    scope: OrgScope,
    ids: number[],
    action: 'cancel' | 'archive' | 'restore' | 'delete',
  ) {
    let affected = 0;

    if (action === 'archive') affected = await this.repository.setArchived(scope, ids, true);
    else if (action === 'restore') affected = await this.repository.setArchived(scope, ids, false);
    else if (action === 'cancel') {
      const cancelled = await this.repository.setCancelled(scope, ids);
      affected = cancelled.length;
      // Unlike a bulk publish (§10.25), a bulk CANCEL must tell people: it is
      // the one change that sends somebody to a room where nothing happens.
      void this.announceCancelled(scope, cancelled);
    }
    else {
      for (const id of ids) {
        try {
          await this.remove(scope, id);
          affected += 1;
        } catch {
          // A session that is not this org's, or already gone. Counted as not
          // affected rather than failing the whole selection.
        }
      }
    }

    return { affected, requested: ids.length, action };
  }

  async get(scope: OrgScope, sessionId: number) {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { session: this.withDisplayStatus(session) };
  }

  async create(scope: OrgScope, dto: SessionDto, actor?: AuthenticatedUser) {
    await this.assertCourseInScope(scope, dto.course_id);

    /*
     * A NEW session must name a real trainer account.
     *
     * Enforced here rather than on the DTO because `SessionDto` is shared
     * with `update()`, and sessions created before trainer accounts existed
     * carry a typed name with no link. Requiring it on edit would make fixing
     * a venue typo on one of those impossible without also reassigning its
     * trainer — a rule that punishes the wrong person for old data.
     *
     * The message names the way out, because the fix is on a different screen
     * and an admin staring at a refused form should not have to guess it.
     */
    if (!dto.trainer_user_id) {
      throw new UnprocessableEntityException(
        'A session needs a trainer account. Pick one from the Trainer list — ' +
          'if it is empty, add a trainer from Manage Users first. Linking the ' +
          'account is what puts the session in their portal, where attendance ' +
          'is marked.',
      );
    }

    const trainer = await this.resolveTrainer(scope, dto.trainer_user_id);
    // Derived, not trusted: when a trainer account is linked, the display name
    // is that account's name, so the column and the link cannot drift apart.
    if (trainer) dto.trainer = trainer.name;
    const id = await this.repository.createSession(scope, this.toRow(dto));
    // The training course is part of creating a session, not a follow-up step:
    // a session with no training would show in the calendar and nowhere else,
    // which is the behaviour this replaces.
    await this.repository.createTraining(scope, id, this.trainingValues(dto));
    await this.syncTrainingThumbnail(scope, id, dto.thumbnail_url);

    await this.activity.record(scope, {
      type: 'session_created',
      detail: `Scheduled "${dto.title}"${dto.date ? ` for ${dto.date}` : ''}`,
      actor: actor ?? null,
      subjectType: 'session',
      subjectId: id,
    });

    void this.announceTrainer(scope, {
      sessionId: id,
      title: dto.title,
      date: dto.date ?? null,
      trainerUserId: trainer?.id ?? null,
      trainerName: dto.trainer ?? trainer?.name ?? null,
      actor,
    });

    // A session learners may book themselves onto is news to all of them, not
    // just to a roster that does not exist yet (0035).
    if (this.isOpenToLearners({ enroll_mode: dto.enroll_mode ?? 'assigned', status: dto.status ?? 'upcoming', archived_at: null })) {
      void this.announceOpenSession(scope, {
        id,
        title: dto.title,
        date: dto.date ?? null,
        start_time: dto.start_time ?? null,
        session_type: dto.session_type ?? null,
      });
    }

    return {
      session: this.withDisplayStatus(
        await this.repository.findWithCourse(scope, id),
      ),
    };
  }

  async update(scope: OrgScope, sessionId: number, dto: SessionDto) {
    await this.assertCourseInScope(scope, dto.course_id);
    const trainer = await this.resolveTrainer(scope, dto.trainer_user_id);
    if (trainer) dto.trainer = trainer.name;
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    /*
     * Who was running it BEFORE this save, read before the update overwrites
     * it. Every session edit posts the whole form, so "the trainer field was
     * submitted" does not mean it changed — without this comparison an admin
     * fixing a typo in the venue would re-announce the trainer to the whole
     * roster.
     */
    const previous = await this.repository.findWithCourse(scope, sessionId);
    const trainerChanged =
      (previous?.trainer ?? null) !== (dto.trainer ?? null);

    const requested = dto.status ?? 'upcoming';
    if (requested === 'completed' && before.status !== 'completed') {
      // Completing through the edit form has the same preconditions and the
      // same side effects as the Mark completed action. One rule, one place.
      this.assertAttendanceMarked(
        await this.repository.attendanceTally(scope, sessionId),
      );
    }

    await this.repository.updateSession(scope, sessionId, this.toRow(dto));
    // ensureTraining before updateTraining: updating a training that was never
    // built is a silent no-op, and a session created before this feature that
    // the backfill somehow missed would then stay invisible everywhere but the
    // calendar — the exact failure this replaces.
    await this.ensureTraining(scope, sessionId);
    await this.repository.updateTraining(
      scope,
      sessionId,
      this.trainingValues(dto),
    );
    await this.syncTrainingThumbnail(scope, sessionId, dto.thumbnail_url);

    if (trainerChanged) {
      void this.announceTrainer(scope, {
        sessionId,
        title: dto.title,
        date: dto.date ?? null,
        trainerUserId: trainer?.id ?? null,
        trainerName: dto.trainer ?? null,
      });
    }

    /*
     * Opened for self-enrolment by this save. Same before/after comparison
     * the trainer uses directly above, and for the same reason: the form
     * posts `enroll_mode` on every edit, so without it a venue typo would
     * re-invite the whole organization.
     */
    // `findWithCourse` is raw SQL and comes back loosely typed, so the three
    // fields are narrowed here rather than asserted away.
    const asText = (v: unknown): string | null =>
      typeof v === 'string' ? v : null;
    const wasArchived = asText(previous?.archived_at);
    const wasOpen = this.isOpenToLearners({
      enroll_mode: asText(previous?.enroll_mode) ?? 'assigned',
      status: asText(previous?.status) ?? 'upcoming',
      archived_at: wasArchived,
    });
    const nowOpen = this.isOpenToLearners({
      enroll_mode: dto.enroll_mode ?? 'assigned',
      status: requested,
      archived_at: wasArchived,
    });
    if (!wasOpen && nowOpen) {
      void this.announceOpenSession(scope, {
        id: sessionId,
        title: dto.title,
        date: dto.date ?? null,
        start_time: dto.start_time ?? null,
        session_type: dto.session_type ?? null,
      });
    }

    // The transition INTO cancelled only — the form posts the status on every
    // save, so a later edit to a cancelled session must not re-announce it.
    if (requested === 'cancelled' && before.status !== 'cancelled') {
      void this.announceCancelled(scope, [sessionId]);
    }

    if (requested === 'completed') {
      await this.repository.syncCompletions(scope, sessionId);
    } else if (before.status === 'completed') {
      // Reopened or cancelled after the fact: the training is no longer
      // finished, so the credit and its learning hours go back too. Leaving
      // them would make the completion metrics disagree with the session.
      await this.repository.clearCompletions(scope, sessionId);
    }

    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { session: this.withDisplayStatus(session) };
  }

  /**
   * Deleting a session deletes its training with it — `courses.session_id` is
   * ON DELETE CASCADE, which takes the module, lesson, assignments and
   * completions with it.
   *
   * The one thing the cascade cannot reach is the cover picture on disk, so
   * that is read before the delete and dropped after.
   */
  async remove(scope: OrgScope, sessionId: number) {
    // The cascade takes the training course row; it does not take the picture
    // off disk, so read it while the row still exists.
    const thumbnailUrl = await this.repository.findTrainingThumbnail(
      scope,
      sessionId,
    );
    await this.repository.deleteSession(scope, sessionId);
    await this.media.discardCourseThumbnail(thumbnailUrl);
    return { message: 'Session deleted' };
  }

  /**
   * The manual completion the admin triggers once the session has happened.
   *
   * This is the only thing that credits the training, and it credits exactly
   * the learners the attendance record says took it — present, late or partial.
   * Absent and excused get nothing, and an unmarked attendance record credits
   * nobody, so the action refuses rather than silently doing nothing.
   */
  async complete(scope: OrgScope, sessionId: number) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    if (before.status === 'cancelled') {
      throw new UnprocessableEntityException(
        'A cancelled session cannot be marked completed.',
      );
    }

    const tally = await this.repository.attendanceTally(scope, sessionId);
    this.assertAttendanceMarked(tally);

    await this.repository.updateSession(scope, sessionId, { status: 'completed' });
    await this.repository.syncCompletions(scope, sessionId);

    const session = await this.repository.findWithCourse(scope, sessionId);
    return {
      session: this.withDisplayStatus(session),
      credited: tally.credited,
      message:
        tally.credited === 1
          ? '1 learner credited with this training.'
          : `${tally.credited} learners credited with this training.`,
    };
  }

  /* ── Roster ── */

  async roster(scope: OrgScope, sessionId: number) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    const [enrolled, available] = await Promise.all([
      this.repository.enrolled(scope, sessionId),
      this.repository.available(scope, sessionId),
    ]);
    return { enrolled, available };
  }

  async addToRoster(scope: OrgScope, sessionId: number, adminId: number, dto: RosterAddDto) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    let added: number[];
    if (dto.enroll_all && dto.department) {
      added = await this.repository.enrollDepartment(scope, sessionId, dto.department);
    } else if (dto.user_id) {
      added = await this.repository.addToRoster(scope, sessionId, dto.user_id);
    } else {
      throw new BadRequestException('user_id or enroll_all+department required');
    }

    // Being on the roster IS being assigned the training — that is the point
    // of the feature, so the two are never written apart.
    await this.ensureTraining(scope, sessionId);
    await this.repository.assignRosterToTraining(scope, sessionId, adminId);

    // An admin who adds a learner after the session was completed and attended
    // is adding someone who did not attend: the assignment appears, the credit
    // does not. syncCompletions keeps that consistent either way.
    const session = await this.repository.findStatus(scope, sessionId);
    if (session?.status === 'completed') {
      await this.repository.syncCompletions(scope, sessionId);
    }

    /*
     * Tell exactly the people just booked on it — the ids the INSERT actually
     * returned, not the whole roster.
     *
     * It used to read the roster as it now stood, because `enroll_all +
     * department` names no ids in the request and that was the only way to
     * know who had been added. The cost was an existing member re-notified
     * whenever anybody else joined, written off as rare because an admin adds
     * people in one go. Self-enrolment (0035) removed that assumption:
     * twenty learners booking themselves onto one session would have sent the
     * first of them nineteen notifications. `RETURNING` past the
     * ON CONFLICT is what makes the honest list available.
     */
    if (added.length === 0) return this.roster(scope, sessionId);
    void (async () => {
      const full = await this.repository.findWithCourse(scope, sessionId);
      void this.notifications.notify({
        userIds: added,
        organizationId: scope.organizationId,
        type: 'session_enrolled',
        title: `You are booked on "${full?.title ?? 'a session'}"`,
        body: [full?.date, full?.start_time, full?.venue]
          .filter(Boolean)
          .join(' · ') || 'Check My Courses for the details.',
        link: '/training-calendar',
        subjectType: 'session',
        subjectId: sessionId,
        actorName: 'Your L&D team',
        exceptUserId: adminId,
      });
    })();

    return this.roster(scope, sessionId);
  }

  /* ── Self-enrolment, from the Course Catalogue (0035) ── */

  /**
   * A learner books themselves onto a session.
   *
   * Goes through `addToRoster`, NEVER a direct insert — being on the roster
   * IS being assigned the companion training (§10.7), and a hand-written
   * roster row would enrol somebody in name only: no course card, no hours,
   * nothing for attendance to credit. §10.16 already states this rule for
   * `promoteFromWaitlist`, and it is the same rule.
   *
   * The learner's own id is passed as the assigner, which is deliberate and
   * is the whole record that this was self-service:
   * `user_course_assignments.assigned_by = user_id` and no new column
   * (0035's header). It also means `exceptUserId` filters them out of the
   * "you are booked on" notification, which is right — they just pressed the
   * button.
   *
   * At capacity they join the WAITLIST rather than being refused. A queue is
   * what a full self-enrol session is for, and it already exists (0025); a
   * 409 would send them away with nothing to do.
   */
  async selfEnrol(scope: OrgScope, sessionId: number, userId: number) {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');

    if (
      !this.isOpenToLearners({
        enroll_mode: typeof session.enroll_mode === 'string' ? session.enroll_mode : null,
        status: typeof session.status === 'string' ? session.status : null,
        archived_at: typeof session.archived_at === 'string' ? session.archived_at : null,
      })
    ) {
      throw new UnprocessableEntityException(
        'This session is not open for self-enrolment. Ask your L&D team to add you.',
      );
    }

    // Already booked: say so rather than 409. The catalogue does not offer
    // the button in that state, so reaching here means two tabs or a stale
    // page, and the honest answer to "put me on this" is that they are on it.
    if (await this.repository.isOnRoster(scope, sessionId, userId)) {
      return { state: 'enrolled' as const, already: true, position: null };
    }

    const capacity = Number(session.capacity ?? 0);
    const taken = await this.repository.rosterCount(scope, sessionId);
    if (capacity > 0 && taken >= capacity) {
      const position =
        (await this.repository.addToWaitlist(scope, sessionId, userId)) ??
        (await this.repository.waitlistPosition(scope, sessionId, userId));
      return { state: 'waitlisted' as const, already: false, position };
    }

    await this.addToRoster(scope, sessionId, userId, { user_id: userId });
    return { state: 'enrolled' as const, already: false, position: null };
  }

  /**
   * A learner drops a session they booked themselves.
   *
   * Refused once ATTENDANCE HAS BEEN MARKED, which is the line that matters:
   * `removeFromRoster` withdraws the training and deletes the completion it
   * credited (§10.7), so letting somebody leave after the fact would erase a
   * record of training they actually did — and, if they were marked absent,
   * would let them quietly remove the evidence.
   *
   * There is deliberately no equivalent for a COURSE. Leaving one would
   * delete lesson completions the learner has genuinely earned, with no undo
   * and no admin in the loop; an admin can still unassign from the roster
   * screen, knowing what it costs.
   */
  async selfLeave(scope: OrgScope, sessionId: number, userId: number) {
    const session = await this.repository.findStatus(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');

    // Leaving the QUEUE is always allowed and costs nothing — no roster row,
    // no assignment, nothing credited.
    const removedFromQueue = await this.repository.removeFromWaitlist(
      scope,
      sessionId,
      userId,
    );
    if (removedFromQueue > 0) {
      return { state: 'left' as const, was: 'waitlisted' as const };
    }

    if (!(await this.repository.isOnRoster(scope, sessionId, userId))) {
      throw new NotFoundException('You are not booked on this session');
    }

    if (session.status === 'completed') {
      throw new UnprocessableEntityException(
        'This session has already been completed. Ask your L&D team if you need to be taken off it.',
      );
    }

    const marked = await this.repository.attendanceFor(scope, sessionId, userId);
    if (marked) {
      throw new UnprocessableEntityException(
        'Your attendance for this session has already been marked, so it is part of your training record. Ask your L&D team to remove it.',
      );
    }

    await this.removeFromRoster(scope, sessionId, userId);
    return { state: 'left' as const, was: 'enrolled' as const };
  }

  async removeFromRoster(scope: OrgScope, sessionId: number, userId: number) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    await this.repository.removeFromRoster(scope, sessionId, userId);
    await this.repository.unassignFromTraining(scope, sessionId, userId);
    return this.roster(scope, sessionId);
  }

  /* ── Attendance ── */

  async attendance(scope: OrgScope, sessionId: number) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    return this.shapeAttendance(await this.repository.attendance(scope, sessionId));
  }

  async saveAttendance(
    scope: OrgScope,
    sessionId: number,
    adminId: number,
    dto: SaveAttendanceDto,
  ) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    await this.repository.upsertAttendance(
      scope,
      sessionId,
      // The legacy handler passed `payload.id`, which does not exist on the JWT
      // (the claim is `userId`), so marked_by was always stored as null and the
      // "marked by" name never rendered. Fixed here.
      adminId,
      dto.lock ? 1 : 0,
      dto.records ?? [],
    );

    // Correcting attendance on an already-completed session must move the
    // credit with it, in both directions — otherwise a learner marked absent by
    // mistake keeps the training, the hours and the completion for good.
    const session = await this.repository.findStatus(scope, sessionId);
    if (session?.status === 'completed') {
      await this.repository.syncCompletions(scope, sessionId);
    }

    return this.shapeAttendance(await this.repository.attendance(scope, sessionId));
  }

  /* ── Trainer portal (specs/rbac.md §3.6.1) ─────────────────────────────
     Every method here starts with the same ownership probe, and the probe is a
     SQL predicate rather than a comparison in JavaScript: a session that is
     not this trainer's must be indistinguishable from one that does not exist,
     or the 404 becomes a way to enumerate other trainers' sessions.

     What a trainer deliberately CANNOT do, per decisions 7 and 8: complete a
     session (it credits every attendee with the training, its hours and its
     completion) or change its roster (it creates course assignments). Those
     have no method here at all — there is nothing to reach, rather than a
     guard to get past. */

  async listForTrainer(scope: OrgScope, trainerUserId: number) {
    const rows = (await this.repository.listForTrainer(
      scope,
      trainerUserId,
    )) as Record<string, unknown>[];
    return {
      sessions: rows.map((row) => ({
        ...row,
        course_id: row.course_id ? Number(row.course_id) : null,
        training_course_id: row.training_course_id
          ? Number(row.training_course_id)
          : null,
        capacity: Number(row.capacity),
        roster_count: Number(row.roster_count ?? 0),
        attendance_marked_count: Number(row.marked_count ?? 0),
        credited_count: Number(row.credited_count ?? 0),
        display_status: displayStatus(row as Parameters<typeof displayStatus>[0]),
      })),
    };
  }

  async trainerSession(
    scope: OrgScope,
    sessionId: number,
    trainerUserId: number,
  ) {
    const row = await this.repository.findTrainerSession(
      scope,
      sessionId,
      trainerUserId,
    );
    if (!row) throw new NotFoundException('Session not found');
    const session = row as Record<string, unknown>;
    return {
      session: {
        ...session,
        course_id: session.course_id ? Number(session.course_id) : null,
        training_course_id: session.training_course_id
          ? Number(session.training_course_id)
          : null,
        capacity: Number(session.capacity),
        display_status: displayStatus(
          session as Parameters<typeof displayStatus>[0],
        ),
      },
    };
  }

  async trainerParticipants(
    scope: OrgScope,
    sessionId: number,
    trainerUserId: number,
  ) {
    const owned = await this.repository.findTrainerSession(
      scope,
      sessionId,
      trainerUserId,
    );
    if (!owned) throw new NotFoundException('Session not found');
    return this.shapeTrainerParticipants(
      await this.repository.attendance(scope, sessionId),
    );
  }

  async trainerSaveAttendance(
    scope: OrgScope,
    sessionId: number,
    trainerUserId: number,
    dto: SaveAttendanceDto,
  ) {
    const owned = await this.repository.findTrainerSession(
      scope,
      sessionId,
      trainerUserId,
    );
    if (!owned) throw new NotFoundException('Session not found');

    await this.repository.upsertAttendance(
      scope,
      sessionId,
      // `marked_by` is whoever marked it — the trainer here, an admin from the
      // admin controller. The column records a user, not a role.
      trainerUserId,
      dto.lock ? 1 : 0,
      dto.records ?? [],
    );

    // A trainer cannot complete a session, but an admin may already have, and
    // a correction afterwards still has to move the credit in both directions
    // or a learner marked absent by mistake keeps the training for good.
    const session = await this.repository.findStatus(scope, sessionId);
    if (session?.status === 'completed') {
      await this.repository.syncCompletions(scope, sessionId);
    }

    return this.shapeTrainerParticipants(
      await this.repository.attendance(scope, sessionId),
    );
  }

  /**
   * The admin's attendance shape minus the learner's email address.
   *
   * A trainer needs to know who is in the room and whether they turned up, not
   * how to contact them. Widening this is a PII decision for the owner
   * (`specs/rbac.md` §7.5), so it is narrowed here on purpose rather than
   * reusing `shapeAttendance` and hoping nobody notices what it carries.
   */
  private shapeTrainerParticipants(rows: AttendanceRow[]) {
    return {
      participants: rows.map((row) => ({
        user_id: Number(row.id),
        first_name: row.first_name,
        last_name: row.last_name,
        department: row.department,
        status: row.status || null,
        credits_training: CREDITING_STATUSES.includes(
          (row.status ?? '') as (typeof CREDITING_STATUSES)[number],
        ),
        join_time: row.join_time || '',
        notes: row.notes || '',
        is_locked: Number(row.is_locked) === 1,
      })),
    };
  }

  async listTrainers(scope: OrgScope) {
    const rows = await this.repository.listTrainers(scope);
    return {
      trainers: rows.map((r) => ({
        id: Number(r.id),
        name: `${r.first_name} ${r.last_name}`,
      })),
    };
  }

  /* ── Learner ── */

  async listForLearner(scope: OrgScope, userId: number) {
    const rows = (await this.repository.listForLearner(
      scope,
      userId,
    )) as Record<string, unknown>[];

    return {
      sessions: rows.map((row) => ({
        ...row,
        training_course_id: row.training_course_id
          ? Number(row.training_course_id)
          : null,
        display_status: displayStatus(row as Parameters<typeof displayStatus>[0]),
      })),
    };
  }

  /* ── Helpers ── */

  /**
   * Completion is what credits attendance, so there has to be an attendance
   * record to read. Refusing is better than succeeding with no effect: the
   * admin would otherwise see "Completed" and assume the learners had been
   * credited when nothing had happened.
   *
   * A session where everyone was marked absent IS completable — attendance was
   * taken, it just credits nobody.
   */
  private assertAttendanceMarked(tally: {
    marked: number;
    credited: number;
  }): void {
    if (tally.marked === 0) {
      throw new UnprocessableEntityException(
        'Mark attendance before completing this session — completion credits ' +
          'the learners recorded as present, late or partial.',
      );
    }
  }

  /** Builds the training for a session that predates it, or lost it somehow. */
  private async ensureTraining(scope: OrgScope, sessionId: number): Promise<void> {
    if (await this.repository.findTraining(scope, sessionId)) return;

    const session = (await this.repository.findWithCourse(
      scope,
      sessionId,
    )) as Record<string, unknown> | null;
    if (!session) throw new NotFoundException('Session not found');

    await this.repository.createTraining(scope, sessionId, {
      name: String(session.title ?? 'Live session'),
      description: this.trainingDescription(session),
      isActive: session.status === 'cancelled' ? 0 : 1,
      lessonTitle: String(session.title ?? 'Live session'),
      contentUrl: String(session.venue_url ?? ''),
      durationMinutes: SessionsService.durationMinutes(
        String(session.start_time ?? ''),
        String(session.end_time ?? ''),
      ),
    });
  }

  private withDisplayStatus(session: unknown) {
    if (!session) return session;
    const row = session as Record<string, unknown>;
    return {
      ...row,
      display_status: displayStatus(row as Parameters<typeof displayStatus>[0]),
    };
  }

  private trainingDescription(source: {
    description?: unknown;
    session_type?: unknown;
    trainer?: unknown;
    date?: unknown;
  }): string | null {
    const given =
      typeof source.description === 'string' ? source.description.trim() : '';
    if (given) return given;

    // The card and the lesson page both show this, so an empty session
    // description becomes the facts of the sitting rather than blank space.
    return `${String(source.session_type ?? 'ILT')} session with ${String(
      source.trainer ?? 'a trainer',
    )} on ${String(source.date ?? '')}`.trim();
  }

  /** The training course/lesson fields derived from a session's own fields. */
  private trainingValues(dto: SessionDto) {
    return {
      name: dto.title,
      description: this.trainingDescription({
        description: dto.description,
        session_type: dto.session_type ?? 'ILT',
        trainer: dto.trainer,
        date: dto.date,
      }),
      // A cancelled session's training is deactivated rather than deleted: the
      // learner card disappears (My Courses joins on is_active = 1) while any
      // record of it survives for the admin.
      isActive: (dto.status ?? 'upcoming') === 'cancelled' ? 0 : 1,
      lessonTitle: dto.title,
      contentUrl: dto.venue_url,
      durationMinutes: SessionsService.durationMinutes(
        dto.start_time,
        dto.end_time,
      ),
    };
  }

  /**
   * The scheduled length of the sitting, which is what learning hours credits
   * when the session is completed. Bad data (an end at or before the start)
   * yields 0 rather than a negative that would subtract from a learner's total.
   */
  private static durationMinutes(startTime: string, endTime: string): number {
    const toMinutes = (value: string): number | null => {
      const [hour, minute] = (value || '').split(':').map(Number);
      if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
      return hour * 60 + minute;
    };

    const start = toMinutes(startTime);
    const end = toMinutes(endTime);
    if (start === null || end === null) return 0;
    return Math.max(0, end - start);
  }

  private shapeAttendance(rows: AttendanceRow[]) {
    return {
      records: rows.map((row) => ({
        user_id: Number(row.id),
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        department: row.department,
        status: row.status || null,
        // Whether this learner's attendance credits them with the training,
        // shown next to the choice so the consequence is not a surprise.
        credits_training: CREDITING_STATUSES.includes(
          (row.status ?? '') as (typeof CREDITING_STATUSES)[number],
        ),
        join_time: row.join_time || '',
        notes: row.notes || '',
        is_locked: Number(row.is_locked) === 1,
        marked_by: row.marked_by ? Number(row.marked_by) : null,
        marker_name: row.marker_first
          ? `${row.marker_first} ${row.marker_last}`
          : null,
      })),
      is_locked: rows.some((row) => Number(row.is_locked) === 1),
    };
  }

  /**
   * A session may be linked to a course, and course_id arrives in the request
   * body. `fk_sessions_org_course` would reject another organization's id —
   * but as a constraint violation, i.e. a 500. The caller deserves a 404 that
   * names the problem, matching how user_ids are handled in assignment.
   */
  private async assertCourseInScope(
    scope: OrgScope,
    courseId: unknown,
  ): Promise<void> {
    if (courseId === undefined || courseId === null || courseId === '') return;
    const found = await this.repository.findCourseInScope(
      scope,
      Number(courseId),
    );
    if (!found) throw new NotFoundException('Course not found');
  }

  /**
   * A body-supplied `trainer_user_id` must name a trainer in the CALLER's own
   * organization. 404 rather than 403, matching every other cross-tenant id in
   * this codebase: whether that user exists is not something an admin of
   * another org should be able to learn.
   *
   * Returns the trainer's display name so the caller can derive `trainer` from
   * it. The composite FK would also reject a cross-org id, but a 404 is a
   * better answer than a 500 from a constraint violation.
   */
  /**
   * Can a learner book themselves onto this session right now?
   *
   * One definition, read by the create announcement, the update transition
   * test, the catalogue list and the self-enrol write — so a session that is
   * announced but not listed, or listed and then refused, cannot happen.
   *
   * A COMPLETED or CANCELLED session is not bookable however its mode reads:
   * the mode says who may join, the status says whether joining means
   * anything. A past-but-not-yet-completed session deliberately still is —
   * `display_status` calls that `in_progress` (§10.7), and an admin adding a
   * late arrival to a sitting that has started is a real thing.
   */
  isOpenToLearners(session: {
    enroll_mode?: string | null;
    status?: string | null;
    archived_at?: string | null;
  }): boolean {
    return (
      session.enroll_mode === 'self' &&
      session.status !== 'completed' &&
      session.status !== 'cancelled' &&
      !session.archived_at
    );
  }

  /**
   * "<Session> is open for booking" to every active learner not already on
   * its roster or its waitlist.
   *
   * Never throws; always `void`-ed (§8.4). Deliberately a different TYPE from
   * the course announcement — a session is a date somebody has to keep free,
   * and the sentence that says so is not the sentence that says a course can
   * be started now.
   */
  private async announceOpenSession(
    scope: OrgScope,
    session: {
      id: number;
      title: string;
      date: string | null;
      start_time: string | null;
      session_type: string | null;
    },
  ): Promise<void> {
    const when = [session.date, session.start_time].filter(Boolean).join(' · ');
    await this.notifications.notify({
      userIds: await this.notifications.learnersForOpenSession(
        scope.organizationId,
        session.id,
      ),
      organizationId: scope.organizationId,
      type: 'session_open_enrolment',
      title: `"${session.title}" is open for booking`,
      body: when
        ? `${when}${session.session_type ? ` · ${session.session_type}` : ''} — book your place from the Course Catalogue.`
        : 'Book your place from the Course Catalogue.',
      link: '/catalogue',
      subjectType: 'session',
      subjectId: session.id,
      actorName: 'Your L&D team',
    });
  }

  /**
   * A session touches three audiences and each is told a different sentence.
   *
   * The TRAINER is being given work — "you are running this" — and is the
   * only one for whom it is an instruction. The ADMINS are being told the
   * assignment landed, which is confirmation. The LEARNERS on the roster are
   * being told who will be teaching them, which is news. One shared message
   * would be wrong for at least two of them, which is why the catalogue has
   * separate types rather than one fanned out.
   *
   * Learners are notified only when there is already a roster — on create
   * there never is, so they get nothing here and hear about it from
   * `addToRoster` instead. Sending both would tell an enrolled learner twice.
   *
   * Never throws: every call is `void`-ed and `notify` swallows its own
   * errors (§8.4).
   */
  /**
   * `session_cancelled` — in the catalogue since 0030 with no call site, so a
   * cancelled session told nobody and a learner found out by turning up.
   *
   * Two audiences, two sentences: the roster loses a booking, the trainer
   * loses work. One notify per session, because each names its own sitting —
   * a bulk cancel is a handful of sessions, not a fan-out to optimise.
   * Never throws (§8.4).
   */
  private async announceCancelled(scope: OrgScope, sessionIds: number[]): Promise<void> {
    for (const sessionId of sessionIds) {
      try {
        const s = await this.repository.findWithCourse(scope, sessionId);
        if (!s) continue;
        const title = String(s.title ?? 'A session');
        const date = typeof s.date === 'string' ? s.date : null;
        const start = typeof s.start_time === 'string' ? s.start_time : null;
        const end = typeof s.end_time === 'string' ? s.end_time : null;
        const when = date ? ` on ${cancelDate(date)}` : '';

        const facts: Array<{ label: string; value: string }> = [];
        if (date) facts.push({ label: 'Was scheduled for', value: cancelDate(date) });
        if (start) facts.push({ label: 'Time', value: end ? `${start} – ${end}` : start });
        if (s.trainer) facts.push({ label: 'Trainer', value: String(s.trainer) });

        const trainerId = s.trainer_user_id ? Number(s.trainer_user_id) : null;
        const roster = (await this.notifications.sessionRoster(sessionId)).filter(
          (id) => id !== trainerId,
        );

        if (roster.length > 0) {
          void this.notifications.notify({
            userIds: roster,
            organizationId: scope.organizationId,
            type: 'session_cancelled',
            title: `Cancelled: ${title}`,
            subjectName: title,
            body:
              `${title}${when} will no longer go ahead. You do not need to do `
              + 'anything — if it is rescheduled, you will be told separately.',
            facts: facts.length ? facts : null,
            link: '/my-sessions',
            subjectType: 'session',
            subjectId: sessionId,
            actorName: 'Your L&D team',
          });
        }

        if (trainerId) {
          void this.notifications.notify({
            userIds: [trainerId],
            organizationId: scope.organizationId,
            type: 'session_cancelled',
            title: `Cancelled: ${title}`,
            subjectName: title,
            body:
              `${title}${when} has been cancelled, so you are no longer running it. `
              + 'Nobody needs to be marked for attendance.',
            // Their own name is no news to them.
            facts: facts.filter((f) => f.label !== 'Trainer'),
            link: '/trainer/sessions',
            subjectType: 'session',
            subjectId: sessionId,
            actorName: 'Your L&D team',
          });
        }
      } catch {
        /* best-effort (§8.4) — the session is cancelled either way */
      }
    }
  }

  private async announceTrainer(
    scope: OrgScope,
    input: {
      sessionId: number;
      title: string;
      date: string | null;
      trainerUserId: number | null;
      trainerName: string | null;
      actor?: AuthenticatedUser;
    },
  ): Promise<void> {
    const when = input.date ? ` on ${input.date}` : '';

    if (input.trainerUserId) {
      void this.notifications.notify({
        userIds: [input.trainerUserId],
        organizationId: scope.organizationId,
        type: 'session_assigned_trainer',
        title: `You are running "${input.title}"`,
        body: `Scheduled${when}. Open your sessions to see the participants.`,
        link: '/trainer/sessions',
        subjectType: 'session',
        subjectId: input.sessionId,
        actorName: actorLabel(input.actor),
        exceptUserId: input.actor?.userId ?? null,
      });
    }

    if (!input.trainerName) return;

    void this.notifications.notify({
      userIds: await this.notifications.adminsOf(scope.organizationId),
      organizationId: scope.organizationId,
      type: 'session_trainer_set',
      title: `${input.trainerName} is running "${input.title}"`,
      body: `Scheduled${when}.`,
      link: '/admin/sessions',
      subjectType: 'session',
      subjectId: input.sessionId,
      actorName: actorLabel(input.actor),
      exceptUserId: input.actor?.userId ?? null,
    });

    const roster = await this.notifications.sessionRoster(input.sessionId);
    if (roster.length === 0) return;
    void this.notifications.notify({
      userIds: roster,
      organizationId: scope.organizationId,
      type: 'session_trainer_set',
      title: `${input.trainerName} will be running "${input.title}"`,
      body: `Scheduled${when}.`,
      link: '/training-calendar',
      subjectType: 'session',
      subjectId: input.sessionId,
      actorName: 'Your L&D team',
    });
  }

  private async resolveTrainer(
    scope: OrgScope,
    trainerUserId: unknown,
  ): Promise<{ id: number; name: string } | null> {
    if (
      trainerUserId === undefined ||
      trainerUserId === null ||
      trainerUserId === ''
    ) {
      return null;
    }
    const trainers = await this.repository.listTrainers(scope);
    const found = trainers.find((t) => Number(t.id) === Number(trainerUserId));
    if (!found) throw new NotFoundException('Trainer not found');
    return {
      id: Number(found.id),
      name: `${found.first_name} ${found.last_name}`,
    };
  }

  private toRow(dto: SessionDto) {
    return {
      title: dto.title,
      sessionType: dto.session_type ?? 'ILT',
      department: dto.department ?? null,
      courseId: dto.course_id ? Number(dto.course_id) : null,
      capacity: dto.capacity ? Number(dto.capacity) : 20,
      trainer: dto.trainer,
      trainerUserId: dto.trainer_user_id ? Number(dto.trainer_user_id) : null,
      venueUrl: dto.venue_url,
      date: dto.date,
      startTime: dto.start_time,
      endTime: dto.end_time,
      description: dto.description ?? null,
      status: dto.status ?? 'upcoming',
      enrollMode: dto.enroll_mode ?? 'assigned',
    };
  }
}

/** "31 May 2026" from a session's bare YYYY-MM-DD. */
function cancelDate(value: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
