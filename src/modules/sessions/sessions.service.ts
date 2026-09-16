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
  RosterAddDto,
  SaveAttendanceDto,
  SessionDto,
} from './dto/session.dto';
import { displayStatus } from './session-status.util';
import { SessionsRepository, type AttendanceRow } from './sessions.repository';

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

  async list(scope: OrgScope) {
    const rows = (await this.repository.list(scope)) as Record<
      string,
      unknown
    >[];
    return {
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
      })),
    };
  }

  async get(scope: OrgScope, sessionId: number) {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { session: this.withDisplayStatus(session) };
  }

  async create(scope: OrgScope, dto: SessionDto, actor?: AuthenticatedUser) {
    await this.assertCourseInScope(scope, dto.course_id);
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

    if (dto.enroll_all && dto.department) {
      await this.repository.enrollDepartment(scope, sessionId, dto.department);
    } else if (dto.user_id) {
      await this.repository.addToRoster(scope, sessionId, dto.user_id);
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

    return this.roster(scope, sessionId);
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
    };
  }
}
