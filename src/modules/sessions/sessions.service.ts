import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  ConflictException,
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
import {
  batchName,
  buildSittings,
  datesBetween,
  formatSessionDates,
  MAX_SESSION_DATES,
  MAX_SITTING_DAYS,
  normaliseDates,
  planSchedule,
  seatsAcrossDates,
  shortDate,
  sittingIsBookable,
  type DateChange,
  type Sitting,
} from '@/common/session-schedule';
import { batchDisplayStatus } from '@/common/session-enrolment';
import { displayStatus } from './session-status.util';
import {
  SessionsRepository,
  type AttendanceRow,
  type SessionDateRow,
  type SessionWithCourseRow,
} from './sessions.repository';
import { CertificatesService } from '@/modules/certificates/certificates.service';
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
    /** Session certificates on completion (§10.66). Best-effort, never throws. */
    private readonly certificates: CertificatesService,
  ) {}

  /**
   * Credits a COMPLETED session and issues what that earns, in one place, so
   * every path that credits (completing it, saving it as completed, adding to
   * its roster, correcting its attendance by admin or trainer) also issues.
   *
   * `syncCompletions` moves the training credit and its learning hours in both
   * directions; `issueForSession` only ever ADDS certificates, once per
   * learner. Taking credit back (reopened, or marked absent later) leaves an
   * issued certificate in place by the owner's decision; an admin revokes it.
   */
  private async creditCompleted(
    scope: OrgScope,
    sessionId: number,
    actor?: AuthenticatedUser | null,
  ): Promise<{ issued: number }> {
    await this.repository.syncCompletions(scope, sessionId);
    return this.certificates.issueForSession(scope, sessionId, actor);
  }

  /** The admin's certificate log for a session (§10.66). */
  certificateLog(scope: OrgScope, sessionId: number) {
    return this.certificates.sessionLog(scope, sessionId);
  }

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
    const [batches, waiting, dateRows] = await Promise.all([
      this.repository.listBatchesForSessions(scope, ids),
      this.repository.waitlistCounts(scope, ids),
      this.repository.listDatesForSessions(scope, ids),
    ]);
    const datesBySession = groupDates(dateRows);

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
        // Every scheduled date, in order, with postponed/preponed (0076).
        ...scheduleFields(datesBySession.get(Number(row.id)) ?? []),
        // Every sitting with its dates and seats (common/session-schedule.ts),
        // the same shape the learner, trainer and catalogue reads carry.
        sittings: buildSittings(
          {
            ...(row as never as SittingSessionRow),
            roster_count: Number(row.roster_count ?? 0),
            waitlist_count: waitingBySession.get(Number(row.id)) ?? 0,
          },
          batchesBySession.get(Number(row.id)) ?? [],
        ),
      })),
    };
  }

  /**
   * Sittings for a set of session rows, in one batch read (§7.1). Used by the
   * learner, trainer and catalogue reads so every view derives seats the same
   * way as the admin list.
   */
  async sittingsFor(
    scope: OrgScope,
    rows: Record<string, unknown>[],
  ): Promise<Map<number, Sitting[]>> {
    const ids = rows.map((r) => Number(r.id));
    const [batches, waiting] = await Promise.all([
      this.repository.listBatchesForSessions(scope, ids),
      this.repository.waitlistCounts(scope, ids),
    ]);
    const waitingBySession = new Map(waiting.map((w) => [w.session_id, Number(w.n)]));
    const out = new Map<number, Sitting[]>();
    for (const row of rows) {
      const id = Number(row.id);
      out.set(
        id,
        buildSittings(
          {
            ...(row as never as SittingSessionRow),
            roster_count: Number(row.roster_count ?? 0),
            waitlist_count: waitingBySession.get(id) ?? 0,
          },
          batches.filter((b) => Number(b.session_id) === id),
        ),
      );
    }
    return out;
  }

  /** Schedule fields (dates, dates in words, rescheduled) for a set of sessions (0076). */
  async scheduleFor(scope: OrgScope, sessionIds: number[]) {
    const grouped = groupDates(await this.repository.listDatesForSessions(scope, sessionIds));
    return new Map(sessionIds.map((id) => [id, scheduleFields(grouped.get(id) ?? [])]));
  }

  /* ── Feedback and report (0074) ──────────────────────────────────────── */

  /** Every learner's feedback on one session, with averages. Admin read. */
  async sessionFeedback(scope: OrgScope, sessionId: number) {
    const session = await this.repository.findStatus(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');
    const rows = await this.repository.feedbackForSession(scope, sessionId);
    const feedback = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.name,
      email: r.email,
      department: r.department,
      jobRole: r.job_role,
      batch: r.batches ?? null,
      ratings: { content: r.rating_content, trainer: r.rating_trainer, delivery: r.rating_delivery },
      average: round1((r.rating_content + r.rating_trainer + r.rating_delivery) / 3),
      comment: r.comment,
      submittedAt: r.created_at,
    }));
    return { summary: feedbackSummary(feedback), feedback };
  }

  /**
   * Everything the Download Session Report needs, in one payload: the session,
   * every sitting with its schedule and seats, totals, each learner's batch,
   * attendance and feedback, and the feedback summary. The Excel file and the
   * printable PDF are both drawn from this, so they cannot disagree.
   */
  async sessionReport(scope: OrgScope, sessionId: number) {
    const row = (await this.repository.findWithCourse(scope, sessionId)) as Record<string, unknown> | null;
    if (!row) throw new NotFoundException('Session not found');
    const [learnerRows, rosterCount, waiting, dateRows] = await Promise.all([
      this.repository.reportLearners(scope, sessionId),
      this.repository.rosterCount(scope, sessionId),
      this.repository.waitlistCounts(scope, [sessionId]),
      this.repository.listDatesForSessions(scope, [sessionId]),
    ]);
    const sittings = (
      await this.sittingsFor(scope, [{ ...row, roster_count: rosterCount }])
    ).get(sessionId) ?? [];

    const learners = learnerRows.map((r) => ({
      name: r.name,
      email: r.email,
      department: r.department,
      jobRole: r.job_role,
      batch: r.batches ?? 'Not placed in a batch',
      enrolledAt: r.enrolled_at,
      attendance: r.attendance,
      joinTime: r.join_time,
      notes: r.notes,
      feedback: r.rating_content === null
        ? null
        : {
            content: r.rating_content,
            trainer: r.rating_trainer,
            delivery: r.rating_delivery,
            average: round1(((r.rating_content ?? 0) + (r.rating_trainer ?? 0) + (r.rating_delivery ?? 0)) / 3),
            comment: r.comment,
            submittedAt: r.feedback_at,
          },
    }));

    const tally = { present: 0, late: 0, partial: 0, absent: 0, excused: 0, unmarked: 0 };
    for (const l of learners) {
      const k = (l.attendance ?? 'unmarked') as keyof typeof tally;
      tally[k in tally ? k : 'unmarked'] += 1;
    }
    const attended = tally.present + tally.late + tally.partial;
    const marked = learners.length - tally.unmarked;
    // Per date: the longest batch, summed; seats: the tightest date (0076).
    const across = seatsAcrossDates(sittings);
    const scheduledMinutes = across.minutes;
    const feedback = learners
      .filter((l) => l.feedback)
      .map((l) => ({ ...l.feedback!, average: l.feedback!.average }));

    const startDates = sittings.map((x) => x.start_date).filter(Boolean) as string[];
    const endDates = sittings.map((x) => x.end_date).filter(Boolean) as string[];

    return {
      generatedAt: new Date().toISOString(),
      session: {
        id: sessionId,
        title: String(row.title ?? ''),
        type: String(row.session_type ?? ''),
        trainer: String(row.trainer ?? ''),
        venue: String(row.venue_url ?? ''),
        status: displayStatus(row as Parameters<typeof displayStatus>[0]),
        enrollMode: String(row.enroll_mode ?? 'assigned'),
        description: (row.description as string | null) ?? null,
        firstDate: startDates.sort()[0] ?? null,
        lastDate: endDates.sort().at(-1) ?? null,
        ...scheduleFields(dateRows),
      },
      totals: {
        learners: learners.length,
        batches: sittings.filter((x) => x.batch_id !== null).length,
        capacity: across.capacity,
        registered: rosterCount,
        available: across.available,
        waitlist: Number(waiting[0]?.n ?? 0),
        attendance: tally,
        attendanceRatePct: marked > 0 ? Math.round((attended / marked) * 100) : null,
        scheduledMinutes,
        feedbackCount: feedback.length,
      },
      sittings,
      learners,
      feedbackSummary: feedbackSummary(feedback),
    };
  }

  /* ── Schedule: dates and day batches (0076, BACKEND_STRUCTURE 10.67) ──── */

  /** Every date with its batches and seats, in order. Admin read. */
  async schedule(scope: OrgScope, sessionId: number) {
    const row = (await this.repository.findWithCourse(scope, sessionId)) as Record<string, unknown> | null;
    if (!row) throw new NotFoundException('Session not found');
    const [dateRows, batches, rosterCount] = await Promise.all([
      this.repository.listDatesForSessions(scope, [sessionId]),
      this.repository.listBatchesForSessions(scope, [sessionId]),
      this.repository.rosterCount(scope, sessionId),
    ]);
    const sittings = buildSittings(
      { ...(row as never as SittingSessionRow), roster_count: rosterCount },
      batches,
    );
    return {
      ...scheduleFields(dateRows),
      dates: dateRows.map((d) => ({
        ...shapeDate(d),
        batches: sittings.filter((x) => x.session_date_id === Number(d.id)),
      })),
    };
  }

  /**
   * Replace the session's dates with the set the admin picked. A date taken
   * away and a date put in are paired in order as a MOVE: the row keeps its
   * batches, placements and attendance and is labelled postponed or
   * preponed. What is left over is added (with the batches of the nearest
   * existing date) or removed (refused when attendance is marked on it).
   */
  async setSchedule(scope: OrgScope, sessionId: number, wanted: string[], actor?: AuthenticatedUser | null) {
    const result = await this.applySchedule(scope, sessionId, wanted);
    await this.afterScheduleChange(scope, sessionId, result, actor);
    return { ...(await this.schedule(scope, sessionId)), changes: result };
  }

  async addDate(scope: OrgScope, sessionId: number, date: string, actor?: AuthenticatedUser | null) {
    const current = await this.repository.listDatesForSessions(scope, [sessionId]);
    if (!(await this.repository.findStatus(scope, sessionId))) throw new NotFoundException('Session not found');
    if (current.some((d) => d.date === date)) {
      throw new ConflictException(`This session already runs on ${shortDate(date)}.`);
    }
    return this.setSchedule(scope, sessionId, [...current.map((d) => d.date), date], actor);
  }

  async moveDate(scope: OrgScope, dateId: number, to: string, actor?: AuthenticatedUser | null) {
    const target = await this.repository.findDate(scope, dateId);
    if (!target) throw new NotFoundException('Date not found');
    const sessionId = Number(target.session_id);
    const current = await this.repository.listDatesForSessions(scope, [sessionId]);
    if (target.date === to) {
      return { ...(await this.schedule(scope, sessionId)), changes: { moves: [], added: [], removed: [] } };
    }
    if (current.some((d) => d.date === to)) {
      throw new ConflictException(`This session already runs on ${shortDate(to)}. Choose another day.`);
    }
    await this.assertSchedulable(scope, sessionId);
    const change = to > target.date ? 'postponed' : 'preponed';
    await this.repository.moveDate(scope, dateId, to, change);
    await this.repository.syncSessionSummary(scope, sessionId);
    const result = { moves: [{ from: target.date, to, change: change as DateChange }], added: [], removed: [] };
    await this.afterScheduleChange(scope, sessionId, result, actor);
    return { ...(await this.schedule(scope, sessionId)), changes: result };
  }

  async removeDate(scope: OrgScope, dateId: number, actor?: AuthenticatedUser | null) {
    const target = await this.repository.findDate(scope, dateId);
    if (!target) throw new NotFoundException('Date not found');
    const sessionId = Number(target.session_id);
    const current = await this.repository.listDatesForSessions(scope, [sessionId]);
    return this.setSchedule(scope, sessionId, current.filter((d) => d.id !== target.id).map((d) => d.date), actor);
  }

  /** A finished or cancelled session's dates are history; they do not move. */
  private async assertSchedulable(scope: OrgScope, sessionId: number) {
    const session = await this.repository.findStatus(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');
    if (session.status === 'completed' || session.status === 'cancelled') {
      throw new UnprocessableEntityException(
        `This session is ${session.status}, so its dates can no longer change. Reopen it first.`,
      );
    }
    return session;
  }

  /**
   * The schedule diff, applied. Returns what changed. Shared by the schedule
   * endpoints and by a session edit that sends `dates` (or a new range).
   */
  private async applySchedule(scope: OrgScope, sessionId: number, wanted: string[]) {
    const desired = normaliseDates(wanted);
    if (desired.length === 0) throw new BadRequestException('A session needs at least one date.');
    if (desired.length > MAX_SESSION_DATES) {
      throw new BadRequestException(`A session can have at most ${MAX_SESSION_DATES} dates.`);
    }
    const current = await this.repository.listDatesForSessions(scope, [sessionId]);
    const plan = planSchedule(current.map((d) => d.date), desired);
    if (plan.moves.length + plan.added.length + plan.removed.length === 0) return plan;
    await this.assertSchedulable(scope, sessionId);

    const byDate = new Map(current.map((d) => [d.date, d]));
    for (const date of plan.removed) {
      const row = byDate.get(date)!;
      const marked = await this.repository.markedOnDate(scope, row.id);
      if (marked > 0) {
        throw new ConflictException(
          `Attendance is already marked for ${marked} learner${marked === 1 ? '' : 's'} on ${shortDate(date)}, so that date cannot be removed. Move it to another day instead.`,
        );
      }
    }

    // Moves first, latest-first when postponing and earliest-first when
    // preponing, so one move never lands on a date another is about to leave.
    const ordered = [...plan.moves].sort((a, b) =>
      a.change === 'postponed' && b.change === 'postponed' ? b.from.localeCompare(a.from) : a.from.localeCompare(b.from));
    for (const m of ordered) {
      await this.repository.moveDate(scope, byDate.get(m.from)!.id, m.to, m.change);
    }
    for (const date of plan.removed) await this.repository.deleteDate(scope, byDate.get(date)!.id);

    if (plan.added.length > 0) {
      // A new date copies the batches of the nearest remaining date, so a
      // session run in Morning and Afternoon batches keeps both. A session
      // with nothing to copy gets one batch following its own times.
      const remaining = current.filter((d) => !plan.removed.includes(d.date));
      const template = remaining.length
        ? remaining.reduce((best, d) => (Math.abs(Date.parse(d.date) - Date.parse(plan.added[0])) < Math.abs(Date.parse(best.date) - Date.parse(plan.added[0])) ? d : best))
        : null;
      const slots = template ? await this.repository.slotsOfDate(scope, template.id) : [];
      const created = await this.repository.insertDates(scope, sessionId, plan.added);
      await this.repository.createBatchesForDates(
        scope,
        sessionId,
        created,
        slots.length ? slots : [{ label: null, start_time: null, end_time: null, capacity: null }],
      );
    }

    await this.repository.syncSessionSummary(scope, sessionId);
    await this.repository.autoPlace(scope, sessionId);
    if (plan.removed.length > 0) await this.repository.rollUpAttendance(scope, sessionId);
    await this.syncTrainingDuration(scope, sessionId);
    return plan;
  }

  /** The training lesson's length is the daily length times the number of dates. */
  private async syncTrainingDuration(scope: OrgScope, sessionId: number) {
    const row = await this.repository.findWithCourse(scope, sessionId);
    if (!row) return;
    const dates = await this.repository.listDatesForSessions(scope, [sessionId]);
    await this.repository.setTrainingDuration(
      scope,
      sessionId,
      SessionsService.durationMinutes(String(row.start_time ?? ''), String(row.end_time ?? '')) * Math.max(1, dates.length),
    );
  }

  /**
   * Tell the roster and every trainer on the session what moved, in one
   * notification each (bell and email, `session_rescheduled`), and record it
   * in the activity log. Best-effort (§8.4).
   */
  private async afterScheduleChange(
    scope: OrgScope,
    sessionId: number,
    plan: { moves: { from: string; to: string; change: DateChange }[]; added: string[]; removed: string[] },
    actor?: AuthenticatedUser | null,
  ): Promise<void> {
    if (plan.moves.length + plan.added.length + plan.removed.length === 0) return;
    try {
      const session = await this.repository.findWithCourse(scope, sessionId);
      if (!session) return;
      const title = String(session.title ?? 'A session');
      const dates = (await this.repository.listDatesForSessions(scope, [sessionId])).map((d) => d.date);
      const allPostponed = plan.added.length + plan.removed.length === 0 && plan.moves.every((m) => m.change === 'postponed');
      const allPreponed = plan.added.length + plan.removed.length === 0 && plan.moves.every((m) => m.change === 'preponed');
      const headline = allPostponed ? 'Postponed' : allPreponed ? 'Preponed' : 'Schedule changed';

      const facts: Array<{ label: string; value: string }> = [];
      for (const m of plan.moves) {
        facts.push({
          label: m.change === 'postponed' ? 'Postponed' : 'Preponed',
          value: `${shortDate(m.from)} moved to ${shortDate(m.to)}`,
        });
      }
      for (const d of plan.added) facts.push({ label: 'Added', value: shortDate(d) });
      for (const d of plan.removed) facts.push({ label: 'Removed', value: shortDate(d) });
      facts.push({ label: 'Dates now', value: formatSessionDates(dates) });
      const start = typeof session.start_time === 'string' ? session.start_time : null;
      const end = typeof session.end_time === 'string' ? session.end_time : null;
      if (start) facts.push({ label: 'Time', value: end ? `${start} – ${end}` : start });

      const body =
        `The dates for "${title}" have changed. Your batch and times stay the same `
        + 'unless your L&D team tells you otherwise. The new schedule is below.';
      const { learners, trainers } = await this.repository.scheduleAudience(scope, sessionId);
      const learnerIds = learners.filter((id) => !trainers.includes(id));
      if (learnerIds.length > 0) {
        void this.notifications.notify({
          userIds: learnerIds,
          organizationId: scope.organizationId,
          type: 'session_rescheduled',
          title: `${headline}: ${title}`,
          subjectName: title,
          body,
          facts,
          link: '/my-sessions',
          subjectType: 'session',
          subjectId: sessionId,
          actorName: 'Your L&D team',
          exceptUserId: actor?.userId ?? null,
        });
      }
      if (trainers.length > 0) {
        void this.notifications.notify({
          userIds: trainers,
          organizationId: scope.organizationId,
          type: 'session_rescheduled',
          title: `${headline}: ${title}`,
          subjectName: title,
          body: `The dates for "${title}", which you are running, have changed. The new schedule is below.`,
          facts,
          link: '/trainer/sessions',
          subjectType: 'session',
          subjectId: sessionId,
          actorName: actorLabel(actor ?? undefined),
          exceptUserId: actor?.userId ?? null,
        });
      }
      await this.activity.record(scope, {
        type: 'session_rescheduled',
        detail: `${headline} "${title}": ${facts.slice(0, -1).filter((f) => f.label !== 'Dates now' && f.label !== 'Time').map((f) => `${f.label} ${f.value}`).join('; ')}`,
        actor: actor ?? null,
        subjectType: 'session',
        subjectId: sessionId,
      });
    } catch {
      /* best-effort (§8.4): the dates have changed either way */
    }
  }

  /* ── Day batches ─────────────────────────────────────────────────────── */

  /**
   * Add a batch on one date. The date is `session_date_id`, or `date` (added
   * to the session when it does not run that day yet). A legacy `date` to
   * `end_date` range adds the batch on every day of it.
   */
  async createBatch(scope: OrgScope, sessionId: number, dto: SessionBatchDto, actor?: AuthenticatedUser | null) {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) throw new NotFoundException('Session not found');

    let dateIds: number[];
    if (dto.session_date_id) {
      const d = await this.repository.findDate(scope, dto.session_date_id);
      if (!d || Number(d.session_id) !== sessionId) throw new NotFoundException('Date not found on this session');
      dateIds = [Number(d.id)];
    } else {
      const wantedDays = dto.date ? datesBetween(dto.date, endDateFor(dto.date, dto.end_date)) : [];
      if (wantedDays.length === 0) {
        throw new UnprocessableEntityException('Choose the date this batch runs on.');
      }
      let current = await this.repository.listDatesForSessions(scope, [sessionId]);
      const missing = wantedDays.filter((d) => !current.some((c) => c.date === d));
      if (missing.length > 0) {
        await this.assertSchedulable(scope, sessionId);
        // New days arrive with this batch only, not a copy of another day's.
        await this.repository.insertDates(scope, sessionId, missing);
        await this.repository.syncSessionSummary(scope, sessionId);
        current = await this.repository.listDatesForSessions(scope, [sessionId]);
        void this.afterScheduleChange(scope, sessionId, { moves: [], added: missing, removed: [] }, actor);
      }
      dateIds = current.filter((c) => wantedDays.includes(c.date)).map((c) => Number(c.id));
    }

    const created = [];
    for (const dateId of dateIds) {
      const d = (await this.repository.findDate(scope, dateId))!;
      const batchNo = await this.repository.nextBatchNo(scope, dateId);
      created.push(await this.repository.createBatch({
        organizationId: scope.organizationId,
        sessionId,
        sessionDateId: dateId,
        batchNo,
        label: dto.label ?? null,
        date: d.date,
        endDate: null,
        startTime: dto.start_time ?? null,
        endTime: dto.end_time ?? null,
        capacity: dto.capacity ?? null,
        trainerUserId: dto.trainer_user_id ?? null,
      }));
    }
    await this.repository.autoPlace(scope, sessionId);
    await this.syncTrainingDuration(scope, sessionId);
    return { batch: created[0], batches: created };
  }

  async updateBatch(scope: OrgScope, batchId: number, dto: SessionBatchDto) {
    const existing = await this.repository.findBatch(scope, batchId);
    if (!existing) throw new NotFoundException('Batch not found');

    // A batch runs on its date. Moving the day is a schedule change, made on
    // the date, so every batch that day moves together and people are told.
    if (dto.date && existing.date && dto.date !== existing.date) {
      throw new UnprocessableEntityException(
        'A batch runs on its date. To change the day, move the date in the session schedule.',
      );
    }

    // Capacity can be raised freely; lowering it below the people already
    // placed would overbook the batch on paper, so it is refused in words.
    if (dto.capacity !== undefined && dto.capacity !== null) {
      const placed = await this.repository.batchRosterCount(scope, batchId);
      if (dto.capacity < placed) {
        throw new ConflictException(
          `${batchName(existing.batch_no, existing.label)} already has ${placed} learner${placed === 1 ? '' : 's'}, so its capacity cannot be lower than that. Move people out first.`,
        );
      }
    }

    const batch = await this.repository.updateBatch(scope, batchId, {
      label: dto.label ?? null,
      date: existing.date,
      endDate: null,
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
    if (existing.session_date_id && (await this.repository.batchCountOnDate(scope, existing.session_date_id)) <= 1) {
      throw new UnprocessableEntityException(
        'This is the only batch on its date. Remove the date from the schedule instead.',
      );
    }
    await this.repository.deleteBatch(scope, batchId);
    // With one batch left that day, its people are placed in it.
    await this.repository.autoPlace(scope, Number(existing.session_id));
    return { message: 'Batch deleted. Its learners stay on the session; place them in another batch on that date.' };
  }

  /**
   * Place a rostered learner in a batch on that batch's date (0076). With
   * `batch_id: null`, take them off one date (`session_date_id`) or, with no
   * date, off every date that offers a choice.
   */
  async setRosterBatch(
    scope: OrgScope,
    sessionId: number,
    dto: MoveToBatchDto,
  ) {
    const batchId = dto.batch_id ?? null;
    if (!(await this.repository.isOnRoster(scope, sessionId, dto.user_id))) {
      throw new NotFoundException('That learner is not on this session');
    }
    if (batchId === null) {
      if (dto.session_date_id) await this.repository.unplaceMember(scope, sessionId, dto.session_date_id, dto.user_id);
      else await this.repository.removeMembers(scope, sessionId, dto.user_id);
      // A date with only one batch is never left without them.
      await this.repository.autoPlace(scope, sessionId);
      return { ok: true };
    }
    await this.repository.withSeatLock(sessionId, async () => {
      await this.assertBatchHasRoom(scope, sessionId, batchId, dto.user_id);
      await this.repository.placeMember(scope, sessionId, batchId, dto.user_id);
    });
    return { ok: true };
  }

  /**
   * The one capacity rule for placing a person in a batch (0074): the batch
   * must belong to this session, be open (scheduled or pending a date) and
   * have a seat. A person already in the batch does not need a new seat.
   * Callers hold `withSeatLock`, so the count cannot change underneath.
   */
  private async assertBatchHasRoom(
    scope: OrgScope,
    sessionId: number,
    batchId: number,
    userId?: number,
  ) {
    const batch = await this.repository.findBatch(scope, batchId);
    if (!batch || Number(batch.session_id) !== sessionId) {
      throw new NotFoundException('Batch not found on this session');
    }
    const name = batchName(batch.batch_no, batch.label);
    if (batch.status === 'cancelled' || batch.status === 'completed') {
      throw new UnprocessableEntityException(`${name} is ${batch.status} and takes no more learners.`);
    }
    if (userId !== undefined && (await this.repository.isInBatch(scope, batchId, userId))) return batch;
    const session = await this.repository.findStatus(scope, sessionId);
    const capacity = batch.capacity ?? Number((session as { capacity?: number } | null)?.capacity ?? 0);
    const placed = await this.repository.batchRosterCount(scope, batchId);
    if (capacity > 0 && placed >= capacity) {
      throw new ConflictException(`${name} is full (${placed} of ${capacity}). Choose another batch or raise its capacity.`);
    }
    return batch;
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

    // Promoted into the batch they queued for, when they queued for one; that
    // batch must have a seat (no overbooking, 0074).
    const entry = await this.repository.waitlistEntry(scope, sessionId, userId);
    if (!entry) throw new NotFoundException('That learner is not on this waitlist');
    await this.addToRoster(scope, sessionId, adminUserId, {
      user_id: userId,
      batch_id: entry.batch_id ?? null,
    });
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
    // Every date it runs on (0076): the picked dates, or the start-to-end range.
    const dates = this.resolveDates(dto);
    for (const slot of dto.slots ?? []) {
      if (slot.trainer_user_id) await this.resolveTrainer(scope, slot.trainer_user_id);
    }
    const id = await this.repository.createSession(scope, this.toRow(dto));
    // Each date gets one batch per time slot. With no slots, one batch that
    // follows the session's own times and capacity.
    const createdDates = await this.repository.insertDates(scope, id, dates);
    await this.repository.createBatchesForDates(
      scope,
      id,
      createdDates,
      dto.slots?.length
        ? dto.slots.map((x) => ({
            label: x.label ?? null,
            start_time: x.start_time ?? null,
            end_time: x.end_time ?? null,
            capacity: x.capacity ?? null,
            trainer_user_id: x.trainer_user_id ?? null,
          }))
        : [{ label: null, start_time: null, end_time: null, capacity: null }],
    );
    // The training course is part of creating a session, not a follow-up step:
    // a session with no training would show in the calendar and nowhere else,
    // which is the behaviour this replaces.
    await this.repository.createTraining(scope, id, this.trainingValues(dto, dates.length));
    await this.syncTrainingThumbnail(scope, id, dto.thumbnail_url);

    await this.activity.record(scope, {
      type: 'session_created',
      detail: `Scheduled "${dto.title}" for ${formatSessionDates(dates)}`,
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

  async update(
    scope: OrgScope,
    sessionId: number,
    dto: SessionDto,
    actor?: AuthenticatedUser,
  ) {
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

    // The dates (0076): an explicit list, or a changed start/end range from an
    // older form. Applied before the status, so a schedule change on a session
    // being completed in the same save is still allowed.
    const prevEnd = typeof previous?.end_date === 'string' ? previous.end_date : null;
    const wantedDates = dto.dates?.length
      ? dto.dates
      : dto.date !== previous?.date || (dto.end_date ?? null) !== prevEnd
        ? datesBetween(dto.date, endDateFor(dto.date, dto.end_date))
        : null;
    const plan = wantedDates ? await this.applySchedule(scope, sessionId, wantedDates) : null;

    const requested = dto.status ?? 'upcoming';
    if (requested === 'completed' && before.status !== 'completed') {
      // Completing through the edit form has the same preconditions and the
      // same side effects as the Mark completed action. One rule, one place.
      this.assertAttendanceMarked(
        await this.repository.attendanceTally(scope, sessionId),
      );
    }

    // The date columns are a summary of session_dates, kept by applySchedule.
    const { date: _date, endDate: _endDate, ...row } = this.toRow(dto);
    await this.repository.updateSession(scope, sessionId, row);
    const dayCount = (await this.repository.listDatesForSessions(scope, [sessionId])).length;
    // ensureTraining before updateTraining: updating a training that was never
    // built is a silent no-op, and a session created before this feature that
    // the backfill somehow missed would then stay invisible everywhere but the
    // calendar — the exact failure this replaces.
    await this.ensureTraining(scope, sessionId);
    await this.repository.updateTraining(
      scope,
      sessionId,
      this.trainingValues(dto, dayCount),
    );
    await this.syncTrainingThumbnail(scope, sessionId, dto.thumbnail_url);
    if (plan) await this.afterScheduleChange(scope, sessionId, plan, actor);

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
      await this.creditCompleted(scope, sessionId, actor);
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
    // A foreign or unknown id deletes nothing and is a 404 (§5.3), never a
    // "Session deleted" that did not happen. `bulk()` relies on the throw to
    // leave it out of `affected`.
    if (!(await this.repository.deleteSession(scope, sessionId))) {
      throw new NotFoundException('Session not found');
    }
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
  async complete(scope: OrgScope, sessionId: number, actor?: AuthenticatedUser) {
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
    const { issued } = await this.creditCompleted(scope, sessionId, actor);

    const session = await this.repository.findWithCourse(scope, sessionId);
    const credited =
      tally.credited === 1
        ? '1 learner credited with this training'
        : `${tally.credited} learners credited with this training`;
    return {
      session: this.withDisplayStatus(session),
      credited: tally.credited,
      certificatesIssued: issued,
      message:
        issued === 0
          ? `${credited}.`
          : `${credited}; ${issued === 1 ? '1 certificate' : `${issued} certificates`} issued and emailed.`,
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
    } else if (dto.user_id && dto.batch_id) {
      // Straight into a batch: the seat check and the insert are one locked step.
      const userId = dto.user_id;
      const batchId = dto.batch_id;
      added = await this.repository.withSeatLock(sessionId, async () => {
        await this.assertBatchHasRoom(scope, sessionId, batchId, userId);
        const ids = await this.repository.addToRoster(scope, sessionId, userId);
        await this.repository.placeMember(scope, sessionId, batchId, userId);
        return ids;
      });
    } else if (dto.user_id) {
      added = await this.repository.addToRoster(scope, sessionId, dto.user_id);
    } else {
      throw new BadRequestException('user_id or enroll_all+department required');
    }

    // Being on the roster IS being assigned the training — that is the point
    // of the feature, so the two are never written apart.
    await this.ensureTraining(scope, sessionId);
    await this.repository.assignRosterToTraining(scope, sessionId, adminId);
    // Placed on every date that has only one batch (0076).
    await this.repository.autoPlace(scope, sessionId);

    // An admin who adds a learner after the session was completed and attended
    // is adding someone who did not attend: the assignment appears, the credit
    // does not. syncCompletions keeps that consistent either way.
    const session = await this.repository.findStatus(scope, sessionId);
    if (session?.status === 'completed') {
      await this.creditCompleted(scope, sessionId);
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
      if (!full) return;
      const { facts, link } = await this.sessionLearnerDetails(scope, full);
      void this.notifications.notify({
        userIds: added,
        organizationId: scope.organizationId,
        type: 'session_enrolled',
        title: `You are booked on "${full.title ?? 'a session'}"`,
        subjectName: String(full.title ?? 'a session'),
        body:
          `You have a place on "${full.title ?? 'this session'}". The details are `
          + 'below; your trainer marks attendance, and that is what credits the training.',
        facts,
        link,
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
  async selfEnrol(
    scope: OrgScope,
    sessionId: number,
    user: AuthenticatedUser,
    batchId?: number,
    batchIds?: number[],
  ) {
    const userId = user.userId;
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

    // A learner attends every date and is placed in one batch on each (0076).
    // A date with one open batch needs no choice; a date with several needs
    // one chosen batch. Each batch has its own seats and its own queue.
    const [batchRows, dateRows] = await Promise.all([
      this.repository.listBatchesForSessions(scope, [sessionId]),
      this.repository.listDatesForSessions(scope, [sessionId]),
    ]);
    const open = batchRows.filter(
      (b) => b.date && b.status !== 'cancelled' && sittingIsBookable({ status: batchDisplayStatus(b) }),
    );
    const chosenIds = new Set<number>([...(batchIds ?? []), ...(batchId !== undefined ? [batchId] : [])].map(Number));
    if ([...chosenIds].some((id) => !open.some((b) => Number(b.id) === id))) {
      throw new UnprocessableEntityException('That batch is not open for booking. Choose another batch.');
    }
    const picks: typeof open = [];
    const missing: string[] = [];
    for (const d of dateRows) {
      const onDate = open.filter((b) => Number(b.session_date_id) === Number(d.id));
      if (onDate.length === 0) continue;
      const chosen = onDate.filter((b) => chosenIds.has(Number(b.id)));
      if (chosen.length > 1) {
        throw new UnprocessableEntityException(`Choose one batch on ${shortDate(d.date)}, not ${chosen.length}.`);
      }
      if (chosen.length === 1) picks.push(chosen[0]);
      else if (onDate.length === 1) picks.push(onDate[0]);
      else missing.push(shortDate(d.date));
    }
    if (missing.length > 0) {
      throw new UnprocessableEntityException(
        `Choose a batch to book for ${missing.join(', ')}. This session runs in more than one batch on ${missing.length === 1 ? 'that date' : 'those dates'}.`,
      );
    }

    // Only a session that offers a choice of batch talks about batches: one
    // with a single batch per date books, queues and answers exactly like a
    // single sitting (its queue is the session's).
    const hadChoice = dateRows.some(
      (d) => open.filter((b) => Number(b.session_date_id) === Number(d.id)).length > 1,
    );

    const outcome = await this.repository.withSeatLock(sessionId, async () => {
      if (picks.length > 0) {
        for (const b of picks) {
          const capacity = b.capacity ?? Number(session.capacity ?? 0);
          const placed = await this.repository.batchRosterCount(scope, Number(b.id));
          if (capacity > 0 && placed >= capacity) {
            const queueFor = hadChoice ? Number(b.id) : null;
            const position =
              (await this.repository.addToWaitlist(scope, sessionId, userId, queueFor)) ??
              (await this.repository.waitlistPosition(scope, sessionId, userId));
            return { state: 'waitlisted' as const, position, batchId: queueFor };
          }
        }
        // addToRoster's own notify EXCLUDES the person it was told is the
        // "admin", which here is the learner themselves, so it sends them
        // nothing; the self-enrol receipt is sent below with its own wording.
        await this.addToRoster(scope, sessionId, userId, { user_id: userId });
        for (const b of picks) await this.repository.placeMember(scope, sessionId, Number(b.id), userId);
        return { state: 'enrolled' as const, position: null, batchId: hadChoice ? Number(picks[0].id) : null };
      }

      const capacity = Number(session.capacity ?? 0);
      const taken = await this.repository.rosterCount(scope, sessionId);
      if (capacity > 0 && taken >= capacity) {
        const position =
          (await this.repository.addToWaitlist(scope, sessionId, userId)) ??
          (await this.repository.waitlistPosition(scope, sessionId, userId));
        return { state: 'waitlisted' as const, position, batchId: null };
      }
      await this.addToRoster(scope, sessionId, userId, { user_id: userId });
      return { state: 'enrolled' as const, position: null, batchId: null };
    });

    if (outcome.state === 'waitlisted') {
      void this.notifySelfWaitlisted(scope, session, user, outcome.position);
      return { state: 'waitlisted' as const, already: false, position: outcome.position, batch_id: outcome.batchId };
    }
    void this.notifySelfEnrolledSession(scope, session, user);
    return {
      state: 'enrolled' as const,
      already: false,
      position: null,
      batch_id: outcome.batchId,
      ...(hadChoice ? { batch_ids: picks.map((b) => Number(b.id)) } : {}),
    };
  }

  /** Receipt to a learner who booked themselves, plus the admin bell. §8.4. */
  private async notifySelfEnrolledSession(
    scope: OrgScope,
    session: SessionWithCourseRow,
    user: AuthenticatedUser,
  ): Promise<void> {
    const title = String(session.title ?? 'a session');
    const { facts, link } = await this.sessionLearnerDetails(scope, session);
    void this.notifications.notify({
      userIds: [user.userId],
      organizationId: scope.organizationId,
      type: 'session_enrolled',
      title: `You booked a place on "${title}"`,
      subjectName: title,
      body:
        `You booked yourself onto "${title}" from the catalogue. The details are `
        + 'below; your trainer marks attendance, and that is what credits the training.',
      facts,
      link,
      subjectType: 'session',
      subjectId: Number(session.id),
      actorName: null,
    });
    void this.notifyAdminSelfEnrol(scope, session, user, 'booked a place on');
  }

  /** Receipt to a learner who joined the waitlist, plus the admin bell. §8.4. */
  private async notifySelfWaitlisted(
    scope: OrgScope,
    session: SessionWithCourseRow,
    user: AuthenticatedUser,
    position: number | null,
  ): Promise<void> {
    const title = String(session.title ?? 'a session');
    const { facts } = await this.sessionLearnerDetails(scope, session);
    const posFacts = position
      ? [{ label: 'Your position', value: `#${position} in the queue` }, ...facts]
      : facts;
    void this.notifications.notify({
      userIds: [user.userId],
      organizationId: scope.organizationId,
      type: 'session_waitlisted',
      title: `You are on the waitlist for "${title}"`,
      subjectName: title,
      body:
        `"${title}" is full, so you are on the waitlist. If a place opens up you `
        + 'move up automatically, in the order people joined, and you will be told.',
      facts: posFacts,
      // The waitlist is managed from My Sessions; never the meeting link, since
      // they do not have a place yet.
      link: '/my-sessions',
      subjectType: 'session',
      subjectId: Number(session.id),
      actorName: null,
    });
    void this.notifyAdminSelfEnrol(scope, session, user, 'joined the waitlist for');
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
  async selfLeave(scope: OrgScope, sessionId: number, user: AuthenticatedUser) {
    const userId = user.userId;
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
      void this.notifySelfLeft(scope, sessionId, user, 'waitlisted');
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
    void this.notifySelfLeft(scope, sessionId, user, 'enrolled');
    return { state: 'left' as const, was: 'enrolled' as const };
  }

  /**
   * Confirms to a learner that they gave up their place (or left the queue).
   * Never throws; always `void`-ed (§8.4). The confirmation matters because
   * leaving is irreversible once a place is given up — somebody who clicked by
   * mistake needs to see it happened and that they can book again.
   */
  private async notifySelfLeft(
    scope: OrgScope,
    sessionId: number,
    user: AuthenticatedUser,
    was: 'enrolled' | 'waitlisted',
  ): Promise<void> {
    const session = await this.repository.findWithCourse(scope, sessionId);
    if (!session) return;
    const title = String(session.title ?? 'a session');
    const body =
      was === 'waitlisted'
        ? `You left the waitlist for "${title}". You can join it again from the `
          + 'catalogue while the session is open.'
        : `You gave up your place on "${title}", so you are no longer booked. You `
          + 'can book again from the catalogue while places last.';
    void this.notifications.notify({
      userIds: [user.userId],
      organizationId: scope.organizationId,
      type: 'session_booking_cancelled',
      title:
        was === 'waitlisted'
          ? `You left the waitlist for "${title}"`
          : `You gave up your place on "${title}"`,
      subjectName: title,
      body,
      link: '/catalogue',
      subjectType: 'session',
      subjectId: sessionId,
      actorName: null,
    });
  }

  async removeFromRoster(scope: OrgScope, sessionId: number, userId: number) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    await this.repository.removeFromRoster(scope, sessionId, userId);
    await this.repository.removeMembers(scope, sessionId, userId);
    await this.repository.unassignFromTraining(scope, sessionId, userId);
    return this.roster(scope, sessionId);
  }

  /* ── Attendance ── */

  async attendance(scope: OrgScope, sessionId: number) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    return this.withDays(scope, sessionId, this.shapeAttendance(await this.repository.attendance(scope, sessionId)));
  }

  /**
   * Adds the per-date view (0076) to an attendance shape: the session's
   * dates, and on each learner their batch and mark on every date.
   */
  private async withDays<T extends { user_id: number }>(
    scope: OrgScope,
    sessionId: number,
    shaped: Record<string, unknown> & { records?: T[]; participants?: T[] },
  ) {
    const [dates, days, members, batches] = await Promise.all([
      this.repository.listDatesForSessions(scope, [sessionId]),
      this.repository.dayAttendance(scope, sessionId),
      this.repository.membersFor(scope, [sessionId]),
      this.repository.listBatchesForSessions(scope, [sessionId]),
    ]);
    const batchById = new Map(batches.map((b) => [Number(b.id), b]));
    const addDays = (r: T) => ({
      ...r,
      days: dates.map((d) => {
        const mark = days.find((x) => Number(x.user_id) === r.user_id && Number(x.session_date_id) === Number(d.id));
        const member = members.find((m) => Number(m.user_id) === r.user_id && Number(m.session_date_id) === Number(d.id));
        const b = member ? batchById.get(Number(member.batch_id)) : undefined;
        return {
          session_date_id: Number(d.id),
          date: d.date,
          batch_id: b ? Number(b.id) : null,
          batch_name: b ? batchName(b.batch_no, b.label) : null,
          status: mark?.status ?? null,
          join_time: mark?.join_time ?? '',
          notes: mark?.notes ?? '',
        };
      }),
    });
    return {
      ...shaped,
      dates: dates.map(shapeDate),
      ...(shaped.records ? { records: shaped.records.map(addDays) } : {}),
      ...(shaped.participants ? { participants: shaped.participants.map(addDays) } : {}),
    };
  }

  /**
   * Marks attendance on one date, or on every date when none is named (which
   * is what a one-day session, and an older client, sends). Then rolls the
   * days up into the overall record that crediting reads (0076).
   */
  private async writeAttendance(scope: OrgScope, sessionId: number, markedBy: number, dto: SaveAttendanceDto) {
    const dates = await this.repository.listDatesForSessions(scope, [sessionId]);
    if (dates.length === 0) {
      // A session with no valid date (pre-0076 bad data): the overall record only.
      await this.repository.upsertAttendance(scope, sessionId, markedBy, dto.lock ? 1 : 0, dto.records ?? []);
      return;
    }
    let dateIds = dates.map((d) => Number(d.id));
    if (dto.session_date_id !== undefined) {
      if (!dateIds.includes(dto.session_date_id)) throw new NotFoundException('Date not found on this session');
      dateIds = [dto.session_date_id];
    }
    await this.repository.upsertDayAttendance(scope, sessionId, dateIds, markedBy, dto.lock ? 1 : 0, dto.records ?? []);
    await this.repository.rollUpAttendance(scope, sessionId);
  }

  async saveAttendance(
    scope: OrgScope,
    sessionId: number,
    adminId: number,
    dto: SaveAttendanceDto,
  ) {
    const before = await this.repository.findStatus(scope, sessionId);
    if (!before) throw new NotFoundException('Session not found');

    // The legacy handler passed `payload.id`, which does not exist on the JWT
    // (the claim is `userId`), so marked_by was always stored as null and the
    // "marked by" name never rendered. Fixed here.
    await this.writeAttendance(scope, sessionId, adminId, dto);

    // Correcting attendance on an already-completed session must move the
    // credit with it, in both directions — otherwise a learner marked absent by
    // mistake keeps the training, the hours and the completion for good.
    const session = await this.repository.findStatus(scope, sessionId);
    if (session?.status === 'completed') {
      await this.creditCompleted(scope, sessionId);
    }

    return this.withDays(scope, sessionId, this.shapeAttendance(await this.repository.attendance(scope, sessionId)));
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
    const [sittings, dateRows] = await Promise.all([
      this.sittingsFor(scope, rows),
      this.repository.listDatesForSessions(scope, rows.map((r) => Number(r.id))),
    ]);
    const datesBySession = groupDates(dateRows);
    return {
      sessions: rows.map((row) => ({
        sittings: sittings.get(Number(row.id)) ?? [],
        ...row,
        ...scheduleFields(datesBySession.get(Number(row.id)) ?? []),
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
    const [dateRows, sittings] = await Promise.all([
      this.repository.listDatesForSessions(scope, [sessionId]),
      this.sittingsFor(scope, [session]),
    ]);
    return {
      session: {
        ...session,
        ...scheduleFields(dateRows),
        sittings: sittings.get(sessionId) ?? [],
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
    return this.withDays(scope, sessionId, this.shapeTrainerParticipants(
      await this.repository.attendance(scope, sessionId),
    ));
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

    // `marked_by` is whoever marked it — the trainer here, an admin from the
    // admin controller. The column records a user, not a role.
    await this.writeAttendance(scope, sessionId, trainerUserId, dto);

    // A trainer cannot complete a session, but an admin may already have, and
    // a correction afterwards still has to move the credit in both directions
    // or a learner marked absent by mistake keeps the training for good.
    const session = await this.repository.findStatus(scope, sessionId);
    if (session?.status === 'completed') {
      await this.creditCompleted(scope, sessionId);
    }

    return this.withDays(scope, sessionId, this.shapeTrainerParticipants(
      await this.repository.attendance(scope, sessionId),
    ));
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
    const ids = rows.map((r) => Number(r.id));
    const [sittings, dateRows, mine] = await Promise.all([
      this.sittingsFor(scope, rows),
      this.repository.listDatesForSessions(scope, ids),
      this.repository.membersFor(scope, ids, userId),
    ]);
    const datesBySession = groupDates(dateRows);

    return {
      sessions: rows.map((row) => ({
        ...row,
        ...scheduleFields(datesBySession.get(Number(row.id)) ?? []),
        my_batch_id: row.my_batch_id ? Number(row.my_batch_id) : null,
        // The learner's batch on each date (0076).
        my_batch_ids: mine
          .filter((m) => Number(m.session_id) === Number(row.id))
          .map((m) => Number(m.batch_id)),
        // All sittings, so the calendar can show the others' availability; the
        // learner's own is `my_batch_id` (null when the session has none, or
        // they are not yet placed in one).
        sittings: sittings.get(Number(row.id)) ?? [],
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
  // Its length is the daily length times the session's dates (0076).
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
      // Per day times the days it runs (a multi-day sitting, 0074).
      durationMinutes:
        SessionsService.durationMinutes(
          String(session.start_time ?? ''),
          String(session.end_time ?? ''),
        ) * Math.max(1, (await this.repository.listDatesForSessions(scope, [sessionId])).length),
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
  private trainingValues(dto: SessionDto, dayCount: number) {
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
      // Per day times the days it runs (a multi-day sitting, 0074).
      durationMinutes:
        SessionsService.durationMinutes(dto.start_time, dto.end_time) * Math.max(1, dayCount),
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
  /**
   * The facts panel and the email CTA target for a learner's session email.
   *
   * One place, so "booked", "waitlisted" and "self-enrolled" all describe the
   * sitting the same way and the place-vs-meeting-link rule is decided once.
   *
   * `venue_url` is a ROOM for an in-person (ILT) session and a MEETING URL for
   * a Virtual one (schema: sessions.venue_url). So a Virtual session shows the
   * URL as a copyable "Join link" fact AND returns it as `link` so the email's
   * button joins the meeting (the one external-link exception, vetted in
   * `EmailRenderService.ctaFor`). An in-person session shows the room as
   * "Venue" and the button goes to My Sessions. Batches (sittings) are listed
   * so a learner who self-enrolled without picking one still sees the dates.
   */
  private async sessionLearnerDetails(
    scope: OrgScope,
    session: SessionWithCourseRow,
  ): Promise<{ facts: Array<{ label: string; value: string }>; link: string }> {
    const type = typeof session.session_type === 'string' ? session.session_type : null;
    // A Webinar is a virtual sitting too — its venue_url is a meeting link.
    const isVirtual = type === 'Virtual' || type === 'Webinar';
    const venueUrl =
      typeof session.venue_url === 'string' ? session.venue_url.trim() : '';
    const date = typeof session.date === 'string' ? session.date : null;
    const start = typeof session.start_time === 'string' ? session.start_time : null;
    const end = typeof session.end_time === 'string' ? session.end_time : null;
    const timeText = start ? (end ? `${start} – ${end}` : start) : null;

    const facts: Array<{ label: string; value: string }> = [];
    if (type) facts.push({ label: 'Format', value: isVirtual ? 'Virtual' : 'In person' });

    // Every date in words, then the batches when a date offers a choice (0076).
    const [dateRows, batches] = await Promise.all([
      this.repository.listDatesForSessions(scope, [Number(session.id)]),
      this.repository.listBatchesForSessions(scope, [Number(session.id)]),
    ]);
    if (dateRows.length > 0) {
      facts.push({ label: dateRows.length === 1 ? 'Date' : 'Dates', value: formatSessionDates(dateRows.map((d) => d.date)) });
    } else if (date) {
      facts.push({ label: 'Date', value: cancelDate(date) });
    }
    const withChoice = dateRows.filter((d) => batches.filter((b) => Number(b.session_date_id) === Number(d.id)).length > 1);
    if (withChoice.length === 0) {
      if (timeText) facts.push({ label: 'Time', value: timeText });
    } else {
      const slots = [...new Set(batches.map((b) => {
        const st = b.start_time ?? start;
        const et = b.end_time ?? end;
        return `${batchName(b.batch_no, b.label)}${st ? `: ${st}${et ? ` – ${et}` : ''}` : ''}`;
      }))];
      facts.push({ label: 'Batches', value: slots.join('; ') });
    }

    if (isVirtual && venueUrl) {
      facts.push({ label: 'Join link', value: venueUrl });
    } else if (!isVirtual && venueUrl) {
      facts.push({ label: 'Venue', value: venueUrl });
    }
    if (session.trainer) facts.push({ label: 'Trainer', value: String(session.trainer) });

    // The button joins the meeting for a virtual session (the URL is vetted in
    // the renderer); everything else points at My Sessions.
    const link = isVirtual && /^https?:\/\//i.test(venueUrl) ? venueUrl : '/my-sessions';
    return { facts, link };
  }

  /** Bell for the org's admins when a learner self-enrols (course or session). */
  private async notifyAdminSelfEnrol(
    scope: OrgScope,
    session: SessionWithCourseRow,
    user: AuthenticatedUser,
    what: 'booked a place on' | 'joined the waitlist for',
  ): Promise<void> {
    const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'A learner';
    const title = String(session.title ?? 'a session');
    void this.notifications.notify({
      userIds: await this.notifications.adminsOf(scope.organizationId),
      organizationId: scope.organizationId,
      type: 'self_enrolment',
      title: `${name} ${what} "${title}"`,
      subjectName: title,
      body: `${name} ${what} "${title}" from the catalogue.`,
      link: '/admin/sessions',
      subjectType: 'session',
      subjectId: Number(session.id),
      actorName: name,
    });
  }

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
        const allDates = (await this.repository.listDatesForSessions(scope, [sessionId])).map((d) => d.date);
        if (allDates.length > 0) facts.push({ label: 'Was scheduled for', value: formatSessionDates(allDates) });
        else if (date) facts.push({ label: 'Was scheduled for', value: cancelDate(date) });
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

  /**
   * The dates a new session runs on: the picked `dates`, or every day from
   * `date` to `end_date`. Sets `date` and `end_date` on the DTO to the first
   * and last, which the session row keeps as a summary.
   */
  private resolveDates(dto: SessionDto): string[] {
    const dates = dto.dates?.length
      ? normaliseDates(dto.dates)
      : datesBetween(dto.date, endDateFor(dto.date, dto.end_date));
    if (dates.length === 0) throw new BadRequestException('date must be YYYY-MM-DD');
    dto.date = dates[0];
    dto.end_date = dates.length > 1 ? dates.at(-1)! : null;
    return dates;
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
      endDate: dto.end_date && dto.end_date !== dto.date ? dto.end_date : null,
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

/**
 * A stored end date: null for a one-day sitting (end equal to the start, or
 * none given), the date itself for a real span. An end before the start is a
 * 400, said in words, rather than silently becoming a one-day sitting.
 */
function endDateFor(start: string | null | undefined, end: string | null | undefined): string | null {
  if (!end || !start || end === start) return null;
  if (end < start) {
    throw new BadRequestException('The end date cannot be before the start date.');
  }
  if (datesBetween(start, end).length >= MAX_SITTING_DAYS) {
    throw new BadRequestException(`A sitting can span at most ${MAX_SITTING_DAYS - 1} days.`);
  }
  return end;
}

/** The session fields buildSittings reads, as a row carries them. */
type SittingSessionRow = {
  title: string;
  date: string;
  end_date?: string | null;
  start_time: string;
  end_time: string;
  capacity: number;
  status: string;
  roster_count: number;
  waitlist_count?: number;
  trainer?: string | null;
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Averages per question and overall, from feedback rows. Null when none. */
function feedbackSummary(
  rows: { content?: number | null; trainer?: number | null; delivery?: number | null; average?: number; ratings?: { content: number; trainer: number; delivery: number } }[],
) {
  if (rows.length === 0) return { count: 0, content: null, trainer: null, delivery: null, overall: null };
  const get = (r: (typeof rows)[number], k: 'content' | 'trainer' | 'delivery') =>
    Number(r.ratings ? r.ratings[k] : r[k] ?? 0);
  const avg = (k: 'content' | 'trainer' | 'delivery') =>
    round1(rows.reduce((n, r) => n + get(r, k), 0) / rows.length);
  const content = avg('content');
  const trainer = avg('trainer');
  const delivery = avg('delivery');
  return { count: rows.length, content, trainer, delivery, overall: round1((content + trainer + delivery) / 3) };
}

/* ── Session dates (0076) ─────────────────────────────────────────────── */

function groupDates(rows: SessionDateRow[]): Map<number, SessionDateRow[]> {
  const out = new Map<number, SessionDateRow[]>();
  for (const r of rows) {
    const list = out.get(Number(r.session_id));
    if (list) list.push(r);
    else out.set(Number(r.session_id), [r]);
  }
  return out;
}

function shapeDate(d: SessionDateRow) {
  return {
    id: Number(d.id),
    date: d.date,
    original_date: d.original_date,
    previous_date: d.previous_date,
    // 'postponed' | 'preponed' | null: what the last move did.
    change: (d.change as DateChange | null) ?? null,
    changed_at: d.changed_at,
  };
}

/**
 * The schedule fields every session read carries (admin, learner, trainer,
 * report): each date in order with its change label, the dates in words
 * ("5th, 6th November and 2nd December 2026"), and whether any moved.
 */
function scheduleFields(rows: SessionDateRow[]) {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  return {
    schedule: sorted.map(shapeDate),
    dates_text: formatSessionDates(sorted.map((d) => d.date)),
    rescheduled: sorted.some((d) => d.change !== null),
  };
}
