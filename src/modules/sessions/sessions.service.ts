import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

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
 */
@Injectable()
export class SessionsService {
  constructor(private readonly repository: SessionsRepository) {}

  async list() {
    const rows = (await this.repository.list()) as Record<string, unknown>[];
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

  async get(sessionId: number) {
    const session = await this.repository.findWithCourse(sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { session: this.withDisplayStatus(session) };
  }

  async create(dto: SessionDto) {
    const id = await this.repository.createSession(this.toRow(dto));
    // The training course is part of creating a session, not a follow-up step:
    // a session with no training would show in the calendar and nowhere else,
    // which is the behaviour this replaces.
    await this.repository.createTraining(id, this.trainingValues(dto));
    return { session: this.withDisplayStatus(await this.repository.findWithCourse(id)) };
  }

  async update(sessionId: number, dto: SessionDto) {
    const before = await this.repository.findStatus(sessionId);
    if (!before) throw new NotFoundException('Session not found');

    const requested = dto.status ?? 'upcoming';
    if (requested === 'completed' && before.status !== 'completed') {
      // Completing through the edit form has the same preconditions and the
      // same side effects as the Mark completed action. One rule, one place.
      this.assertAttendanceMarked(
        await this.repository.attendanceTally(sessionId),
      );
    }

    await this.repository.updateSession(sessionId, this.toRow(dto));
    // ensureTraining before updateTraining: updating a training that was never
    // built is a silent no-op, and a session created before this feature that
    // the backfill somehow missed would then stay invisible everywhere but the
    // calendar — the exact failure this replaces.
    await this.ensureTraining(sessionId);
    await this.repository.updateTraining(sessionId, this.trainingValues(dto));

    if (requested === 'completed') {
      await this.repository.syncCompletions(sessionId);
    } else if (before.status === 'completed') {
      // Reopened or cancelled after the fact: the training is no longer
      // finished, so the credit and its learning hours go back too. Leaving
      // them would make the completion metrics disagree with the session.
      await this.repository.clearCompletions(sessionId);
    }

    const session = await this.repository.findWithCourse(sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return { session: this.withDisplayStatus(session) };
  }

  /**
   * Deleting a session deletes its training with it — `courses.session_id` is
   * ON DELETE CASCADE, which takes the module, lesson, assignments and
   * completions with it. No application-side cleanup to forget.
   */
  async remove(sessionId: number) {
    await this.repository.deleteSession(sessionId);
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
  async complete(sessionId: number) {
    const before = await this.repository.findStatus(sessionId);
    if (!before) throw new NotFoundException('Session not found');

    if (before.status === 'cancelled') {
      throw new UnprocessableEntityException(
        'A cancelled session cannot be marked completed.',
      );
    }

    const tally = await this.repository.attendanceTally(sessionId);
    this.assertAttendanceMarked(tally);

    await this.repository.updateSession(sessionId, { status: 'completed' });
    await this.repository.syncCompletions(sessionId);

    const session = await this.repository.findWithCourse(sessionId);
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

  async roster(sessionId: number) {
    const [enrolled, available] = await Promise.all([
      this.repository.enrolled(sessionId),
      this.repository.available(sessionId),
    ]);
    return { enrolled, available };
  }

  async addToRoster(sessionId: number, adminId: number, dto: RosterAddDto) {
    if (dto.enroll_all && dto.department) {
      await this.repository.enrollDepartment(sessionId, dto.department);
    } else if (dto.user_id) {
      await this.repository.addToRoster(sessionId, dto.user_id);
    } else {
      throw new BadRequestException('user_id or enroll_all+department required');
    }

    // Being on the roster IS being assigned the training — that is the point
    // of the feature, so the two are never written apart.
    await this.ensureTraining(sessionId);
    await this.repository.assignRosterToTraining(sessionId, adminId);

    // An admin who adds a learner after the session was completed and attended
    // is adding someone who did not attend: the assignment appears, the credit
    // does not. syncCompletions keeps that consistent either way.
    const session = await this.repository.findStatus(sessionId);
    if (session?.status === 'completed') {
      await this.repository.syncCompletions(sessionId);
    }

    return this.roster(sessionId);
  }

  async removeFromRoster(sessionId: number, userId: number) {
    await this.repository.removeFromRoster(sessionId, userId);
    await this.repository.unassignFromTraining(sessionId, userId);
    return this.roster(sessionId);
  }

  /* ── Attendance ── */

  async attendance(sessionId: number) {
    return this.shapeAttendance(await this.repository.attendance(sessionId));
  }

  async saveAttendance(
    sessionId: number,
    adminId: number,
    dto: SaveAttendanceDto,
  ) {
    await this.repository.upsertAttendance(
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
    const session = await this.repository.findStatus(sessionId);
    if (session?.status === 'completed') {
      await this.repository.syncCompletions(sessionId);
    }

    return this.shapeAttendance(await this.repository.attendance(sessionId));
  }

  /* ── Learner ── */

  async listForLearner(userId: number) {
    const rows = (await this.repository.listForLearner(
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
  private async ensureTraining(sessionId: number): Promise<void> {
    if (await this.repository.findTraining(sessionId)) return;

    const session = (await this.repository.findWithCourse(sessionId)) as Record<
      string,
      unknown
    > | null;
    if (!session) throw new NotFoundException('Session not found');

    await this.repository.createTraining(sessionId, {
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

  private toRow(dto: SessionDto) {
    return {
      title: dto.title,
      sessionType: dto.session_type ?? 'ILT',
      department: dto.department ?? null,
      courseId: dto.course_id ? Number(dto.course_id) : null,
      capacity: dto.capacity ? Number(dto.capacity) : 20,
      trainer: dto.trainer,
      venueUrl: dto.venue_url,
      date: dto.date,
      startTime: dto.start_time,
      endTime: dto.end_time,
      description: dto.description ?? null,
      status: dto.status ?? 'upcoming',
    };
  }
}
