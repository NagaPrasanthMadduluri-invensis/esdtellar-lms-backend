import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { isMandatory } from '@/common/course-taxonomy';
import { BADGE_CATALOGUE, BADGES, type BadgeDescriptor } from '@/common/badges';
import { hashPassword, verifyPassword } from '@/common/crypto/password.util';
import type { OrgScope } from '@/database/org-scope';
import { badgeHint } from '@/modules/badges/badge-hint.util';
import { BadgesService } from '@/modules/badges/badges.service';
import { CertificatesService } from '@/modules/certificates/certificates.service';
import { LeaderboardService } from '@/modules/leaderboard/leaderboard.service';
// The points model itself, not the ranking: the card promises what the board
// pays, so both read one file (see `courseReward`).
import {
  courseReward,
  POINTS_NOTES,
  POINT_RULES,
  type CourseReward,
} from '@/modules/leaderboard/points';
import {
  LearningHoursService,
  type LabelledPeriod,
} from '@/modules/learning-hours/learning-hours.service';
import { referenceNow } from '@/modules/learning-hours/periods';
// A pure derivation, not a service: "in progress" has to mean the same thing on
// the course card as it does in the calendar, so both read the one function.
import { displayStatus } from '@/modules/sessions/session-status.util';
import { JourneysService } from '@/modules/journeys/journeys.service';
import { actorLabel } from '@/common/notifications';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { SpreadsheetService } from '@/modules/reports/spreadsheet.service';

/**
 * The monthly learning-hours goal a manager's team is measured against.
 *
 * A CONSTANT, not a per-tenant column, and that is a deliberate first cut: it
 * appears in exactly one place (Team Learning) and nothing else in the product
 * has an opinion about how many hours a month is enough. Promoting it to an
 * organization setting means a migration, a form and a decision about what
 * happens to the months already measured against 10 — worth doing when
 * somebody asks for a different number, not before.
 */
const MONTHLY_HOURS_GOAL = 10;

/**
 * THE four bands, and the only place they are decided.
 *
 * Everything that colours a figure by how close it is to its goal reads this
 * — the learner's own meter, every bucket of the period table, and every peer
 * row. They used to be three different vocabularies: the summary said
 * "Almost There", a peer said "Close" at a different threshold, and nothing
 * said what either meant. Three scales on one page is how a learner concludes
 * the page is guessing.
 *
 * The bands are also what the palette hangs off (TASTE §10.1.1): green once
 * the goal is in reach, ochre while it is plausible, red when it is not. The
 * browser maps a LABEL to a colour and never re-derives the band, so there is
 * no second copy free to drift.
 */
export type GoalBand = 'Goal Reached!' | 'Almost There' | 'On Track' | 'Behind';

function goalBand(pct: number): GoalBand {
  if (pct >= 100) return 'Goal Reached!';
  if (pct >= 80) return 'Almost There';
  if (pct >= 50) return 'On Track';
  return 'Behind';
}

/**
 * Where a learner stands against a goal.
 *
 * ONE definition, read by My Progress, the Learning Hours summary, every
 * period bucket and every peer row. They each had their own before, and the
 * moment a threshold moved in one the screens would disagree about whether
 * somebody was "Almost There" — the §10.4 failure in miniature, one number
 * instead of hours.
 *
 * `goal` is a parameter because the period it measures is not always a month:
 * a quarter is worth three of them and a week a fraction of one. What does
 * NOT change per period is the banding, which is the whole point of passing
 * the goal in rather than writing a second function.
 *
 * `goalPct` is CAPPED at 100. A learner who did fifteen hours against a ten
 * hour goal has met it; a bar drawn at 150% just overflows its track.
 */
function goalStatus(
  hours: number,
  goal: number = MONTHLY_GOAL_HOURS,
): {
  goal: number;
  goalPct: number;
  remaining: number;
  statusLabel: GoalBand;
} {
  const goalPct = goal > 0 ? Math.min(Math.round((hours / goal) * 100), 100) : 0;
  return {
    goal: round1(goal),
    goalPct,
    remaining: Math.max(0, round1(goal - hours)),
    statusLabel: goalBand(goalPct),
  };
}

/**
 * What one bucket of each granularity is worth against the monthly goal.
 *
 * The goal is DEFINED monthly (`MONTHLY_GOAL_HOURS`), so every other period
 * is derived from it rather than given its own constant — one number to
 * change, and a quarter is always exactly three months of it. The week is the
 * one that cannot be a whole number of months: 12 months over 52 weeks, which
 * is the honest conversion and lands at 2.3h.
 */
const PERIOD_MONTHS: Record<string, number> = {
  weekly: 12 / 52,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/**
 * Attaches the goal, the percentage and the band to every bucket on an axis.
 *
 * THE CURRENT BUCKET'S GOAL IS PRO-RATED to the part of it that has actually
 * happened. A quarter that is nine days old measured against a full quarter's
 * target reads "10% — Behind" on every screen in early January, which is a
 * verdict on the calendar rather than on the learner. Past buckets are
 * measured against the whole thing, because they had the whole thing.
 */
function withGoals(
  rows: { period: string; label: string; total: number }[],
  granularity: keyof typeof PERIOD_MONTHS,
  now: Date,
) {
  const months = PERIOD_MONTHS[granularity] ?? 1;
  const fullGoal = MONTHLY_GOAL_HOURS * months;
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return rows.map((row) => {
    /* A bucket is CURRENT only when today falls inside it. The axis is
       trimmed to the learner's last activity, so it very often ends in the
       past — treating the last bucket as current would pro-rate a finished
       week down to a few days and excuse a figure that is simply final.
       Measured the wrong way first: a learner whose last activity was in
       June had their June week scored against two days' worth of goal. */
    const isCurrent = todayIso >= row.period && todayIso < periodEnd(row.period, granularity);

    // Never zero: on the first day of a period the goal would be 0 and the
    // percentage undefined. A thirtieth of a period is the floor.
    const elapsed = isCurrent
      ? Math.max(elapsedFraction(row.period, granularity, now), 1 / 30)
      : 1;
    const goal = fullGoal * (isCurrent ? elapsed : 1);
    return { ...row, is_current: isCurrent, ...goalStatus(row.total, goal) };
  });
}

/** The day AFTER the bucket starting at `startIso` ends, as `YYYY-MM-DD`. */
function periodEnd(startIso: string, granularity: keyof typeof PERIOD_MONTHS): string {
  const [y, m, d] = startIso.split('-').map(Number);
  const end = new Date(Date.UTC(y, m - 1, d));
  if (granularity === 'weekly') end.setUTCDate(end.getUTCDate() + 7);
  else if (granularity === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1);
  else if (granularity === 'quarterly') end.setUTCMonth(end.getUTCMonth() + 3);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  return end.toISOString().slice(0, 10);
}

/** How much of the bucket starting at `startIso` has already gone by. */
function elapsedFraction(
  startIso: string,
  granularity: keyof typeof PERIOD_MONTHS,
  now: Date,
): number {
  const [y, m, d] = startIso.split('-').map(Number);
  const start = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const DAY = 86_400_000;
  const lengthDays =
    granularity === 'weekly'
      ? 7
      : granularity === 'monthly'
        ? new Date(Date.UTC(y, m, 0)).getUTCDate()
        : granularity === 'quarterly'
          ? 91
          : 365;
  const gone = (today - start) / DAY + 1;
  return Math.min(1, Math.max(0, gone / lengthDays));
}

/**
 * Minutes to hours, one decimal, across a whole axis — and the parts ADD UP
 * to the total on screen.
 *
 * A reader can add the three columns of the yearly table and check the total,
 * so the row has to be right in front of them. Rounding four numbers
 * independently breaks that about a third of the time (0.25 + 0.25 + 0.25
 * shows as 0.3 + 0.3 + 0.3 = 0.9 beside a total of 0.8), which looks like a
 * bug in a way a tenth of an hour never is.
 *
 * So `total` is the correctly-rounded true total, and the three parts are
 * apportioned to it by LARGEST REMAINDER: round everything down, then hand
 * the leftover tenths to whichever parts were closest to rounding up. That
 * is the standard fix, it moves at most one part by 0.1, and it keeps each
 * year's total honest rather than drifting with the parts.
 *
 * What it cannot fix: two correctly-rounded years can still sum to 0.1 away
 * from the correctly-rounded all-time figure in the tile above. There is no
 * rounding that makes every subtotal in a table agree with every other; this
 * one picks the arithmetic the reader can actually see.
 */
function periodHours(rows: LabelledPeriod[]) {
  return rows.map((row) => {
    const total = round1(row.total / 60);
    const exact = {
      course: row.course / 60,
      path: row.path / 60,
      session: row.session / 60,
    };

    const floors = {
      course: Math.floor(exact.course * 10) / 10,
      path: Math.floor(exact.path * 10) / 10,
      session: Math.floor(exact.session * 10) / 10,
    };
    const parts = { ...floors };

    // Tenths still to hand out, and who has the strongest claim to one.
    let leftover = Math.round((total - (floors.course + floors.path + floors.session)) * 10);
    const byRemainder = (['course', 'path', 'session'] as const)
      .map((key) => ({ key, rem: exact[key] - floors[key] }))
      .sort((a, b) => b.rem - a.rem);

    for (const { key } of byRemainder) {
      if (leftover <= 0) break;
      parts[key] = round1(parts[key] + 0.1);
      leftover -= 1;
    }

    return {
      period: row.period,
      label: row.label,
      course: round1(parts.course),
      path: round1(parts.path),
      session: round1(parts.session),
      total,
    };
  });
}

/**
 * The yearly table: each year's hours by kind, against that year's goal.
 *
 * THE CURRENT YEAR'S GOAL IS PRO-RATED to the months that have actually
 * happened. A full-year target compared against three months of activity
 * would print "25% of goal" every January and read as a failure rather than
 * as a year that has barely started — the reference mock sidesteps this by
 * comparing the current year against a MONTH goal, which makes the column
 * mean two different things in two rows of one table. Saying "of the year so
 * far" keeps one meaning and stays honest.
 */
function yearlyHours(rows: LabelledPeriod[]) {
  const now = referenceNow();
  const thisYear = now.getFullYear();
  const monthsSoFar = now.getMonth() + 1;

  return periodHours(rows).map((row) => {
    const year = Number(row.period.slice(0, 4));
    const isCurrent = year === thisYear;
    const months = isCurrent ? monthsSoFar : 12;
    const goal = round1(MONTHLY_GOAL_HOURS * months);
    return {
      ...row,
      year,
      isCurrent,
      goal,
      goalPct: goal > 0 ? Math.round((row.total / goal) * 100) : 0,
    };
  });
}

import type { ChangePasswordDto } from './dto/change-password.dto';
import {
  addDays,
  avatarColor,
  contentTypeOf,
  DUE_DAYS,
  formatDate,
  initialsOf,
  lastMonth as previousMonthKey,
  minutesToHours,
  modeOf,
  MONTHLY_GOAL_HOURS,
  parseScormDuration,
  parseTimestamp,
  POINTS_PER_LESSON,
  POINTS_PER_PASSED_ASSESSMENT,
  relativeTime,
  round1,
  skillTags,
  thisMonth as currentMonthKey,
  today,
  weeks as monthWeeks,
} from './learner.constants';
import { LearnerRepository } from './learner.repository';

/**
 * The badges reached purely by finishing courses, read from the catalogue
 * (`common/badges.ts`) rather than a second copy of their thresholds — a
 * number changed there and not here would advertise a badge that is not
 * actually awarded (`BadgesService.syncFor` is the one place that decides).
 * Point-total badges (high_flyer, learning_champion) are deliberately absent
 * from the course-card nudge: they need the learner's org-wide points, which
 * the courses page does not fetch, and the achievements page already tracks
 * them.
 */
const COURSE_COUNT_MILESTONES = BADGE_CATALOGUE.filter(
  (b) => b.metric === 'completedCourses',
).sort((a, b) => a.threshold - b.threshold);

const toDisplayTier = (tier: BadgeDescriptor['tier']): string | null =>
  tier ? tier.toUpperCase() : null;

/** The advertised reward on a course card: points, plus what they unlock. */
interface CourseRewardView extends CourseReward {
  /**
   * The next course-count badge still unearned, with how many completions are
   * left. `coursesToGo === 1` means finishing THIS course earns it.
   */
  unlocksBadge: {
    id: string;
    title: string;
    tier: string | null;
    coursesToGo: number;
  } | null;
  /** Quick Learner, when it is still available AND still reachable in time. */
  onTimeBadge: { id: string; title: string; by: string } | null;
}

@Injectable()
export class LearnerService {
  constructor(
    private readonly repository: LearnerRepository,
    private readonly certificates: CertificatesService,
    private readonly hours: LearningHoursService,
    private readonly leaderboard_: LeaderboardService,
    private readonly badges: BadgesService,
    private readonly journeys: JourneysService,
    /** Best-effort (§8.4) — a nudge that fails must not 500 the button. */
    private readonly notifications: NotificationsService,
    /** Rebuilds the team report as .xlsx — see `teamWorkbook`. */
    private readonly spreadsheets: SpreadsheetService,
  ) {}

  /* ─────────────────────────────────────────────
     Shared: points + hours for every learner
  ───────────────────────────────────────────── */

  /**
   * The reward a learner is shown BEFORE they finish — "earn 120 points",
   * "finishing this earns Committed Learner".
   *
   * Returns a mapper rather than a per-row function because two of the three
   * answers depend on the learner's OTHER courses: which course-count badge is
   * next, and whether Quick Learner is already banked. Computing those once
   * over the rows already in hand is what keeps this free of a second query
   * (§7.1) — the alternative was asking the badge logic per card.
   *
   * Every threshold here is read from the same place the award is decided
   * (`common/badges.ts`'s catalogue, via `BadgesService.syncFor`; `courseReward`
   * for the points), because a card that
   * over-promises is worse than a card that says nothing.
   */
  private rewardMapper(
    rows: Awaited<ReturnType<LearnerRepository['assignedCourses']>>,
  ): (row: (typeof rows)[number]) => CourseRewardView {
    const isComplete = (row: (typeof rows)[number]) =>
      Number(row.total_lessons) > 0 &&
      Number(row.completed_lessons) >= Number(row.total_lessons);

    const completedCourses = rows.filter(isComplete).length;

    // Exactly the test `achievements()` applies for `completedBeforeDue`, so
    // the card never offers a badge the achievements page already granted.
    const quickLearnerEarned = rows.some(
      (row) =>
        isComplete(row) &&
        row.last_activity !== null &&
        row.last_activity.slice(0, 10) <= addDays(row.assigned_at, DUE_DAYS),
    );

    // The next course-count threshold still ahead. Any unfinished course is a
    // candidate for being the next one completed, so they all advertise the
    // same badge and the same distance to it — the nearest threshold ABOVE the
    // current count, not only an exact next-course hit, or a learner sitting on
    // one completed course would be told nothing until they reached two.
    const nextMilestone = COURSE_COUNT_MILESTONES.find((b) => b.threshold > completedCourses);
    const now = today();

    return (row) => {
      const reward = courseReward({
        totalLessons: Number(row.total_lessons),
        completedLessons: Number(row.completed_lessons),
        assessmentCount: Number(row.assessment_count),
        passedAssessments: Number(row.passed_assessments),
      });

      const complete = isComplete(row);
      const due = addDays(row.assigned_at, DUE_DAYS);

      return {
        ...reward,
        unlocksBadge:
          complete || !nextMilestone
            ? null
            : {
                id: nextMilestone.id,
                title: nextMilestone.label,
                tier: toDisplayTier(nextMilestone.tier),
                coursesToGo: nextMilestone.threshold - completedCourses,
              },
        // Suppressed for a session training: the learner cannot finish one
        // themselves (§10.7), so dangling a deadline badge in front of them
        // would be asking for something they have no control over. Suppressed
        // once the due date has passed for the same reason — the offer has to
        // still be winnable.
        onTimeBadge:
          complete || quickLearnerEarned || row.session_id !== null || due < now
            ? null
            : { id: 'quick_learner', title: BADGES.quick_learner.label, by: formatDate(due) },
      };
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/courses
  ───────────────────────────────────────────── */

  async courses(scope: OrgScope, userId: number) {
    const [allRows, contentRows] = await Promise.all([
      this.repository.assignedCourses(scope, userId),
      this.repository.courseContentTypes(scope, userId),
    ]);

    /*
     * SESSIONS ARE EXCLUDED FROM MY COURSES — they have their own module.
     *
     * A session still IS a course assignment (§10.7): it owns a companion
     * training course, and that is what credits attendance, hours, the
     * leaderboard and certificates. None of that changes. What changes is
     * only which LIST it appears in, so a learner browsing courses is not
     * shown rows whose progress bar they cannot move themselves.
     *
     * Filtered HERE rather than in `assignedCourses`, deliberately: three
     * other callers share that query — `dashboard`, `progress` and
     * `courseDetail` — and a session is still part of what a learner has been
     * assigned. Narrowing the repository would have silently dropped sessions
     * out of their totals too, which nobody asked for and which would make
     * the dashboard disagree with Learning Hours.
     *
     * Learning hours are untouched by construction: `LearningHoursService`
     * reads `user_lesson_completions` directly (§10.4), never this payload,
     * so a session's minutes keep counting exactly as before.
     */
    const rows = allRows.filter((row) => !row.session_id);

    // What each course actually holds, rather than a hard-coded assumption.
    const typesByCourse = new Map(
      contentRows.map((r) => [
        Number(r.course_id),
        (r.content_types || '').split(',').filter(Boolean),
      ]),
    );

    const rewardOf = this.rewardMapper(rows);

    const courses = rows.map((row) => {
      const total = Number(row.total_lessons);
      const done = Number(row.completed_lessons);
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const dueDate = this.dueDateFor(row);
      const types = typesByCourse.get(Number(row.course_id)) ?? [];
      const meta = {
        contentType: contentTypeOf(types),
        /*
         * Both of these were hardcoded `null` / `false` under a comment
         * saying neither had a column to come from. That was true when it was
         * written and stopped being true at `0019_course_library.sql`, which
         * added `courses.category` and `courses.is_mandatory` — so the
         * learner card's category caption rendered nothing for every course
         * and its MANDATORY ribbon could never appear, while the admin
         * library showed both. A stale comment is why nobody looked again.
         *
         * `isMandatory` is the DERIVED value, not the stored flag: a
         * Compliance course is mandatory whether or not the box was ticked
         * (§10.12), and the learner has no form that round-trips the column,
         * so the only meaning that reaches them is the derived one.
         */
        category: row.category ?? null,
        isMandatory: isMandatory({
          isMandatory: Number(row.is_mandatory ?? 0),
          category: row.category ?? null,
        }),
      };

      const bestScore = row.best_score !== null ? Number(row.best_score) : null;
      const hasAssessment =
        bestScore !== null || Number(row.assessment_count) > 0;
      const hasPassed =
        row.has_passed !== null ? Number(row.has_passed) === 1 : null;
      const hasFailed = pct === 100 && hasAssessment && hasPassed === false;

      let status: string;
      if (hasFailed) status = 'failed';
      else if (pct === 100) status = 'completed';
      else if (pct > 0) status = 'in-progress';
      else status = 'assigned';

      return {
        enrollmentId: row.enrollment_id,
        assignedAt: row.assigned_at,
        assignedFmt: formatDate(row.assigned_at),
        dueDate,
        dueFmt: formatDate(dueDate),
        dueShort: this.shortDate(dueDate),
        status,
        progressPct: pct,
        contentType: meta.contentType,
        category: meta.category,
        isMandatory: meta.isMandatory,
        modulesCount: Number(row.modules_count ?? 0),
        totalMinutes: Number(row.total_minutes),
        // What finishing this course is worth, so the card can say so before
        // the learner starts rather than only crediting them afterwards.
        reward: rewardOf(row),
        bestScore,
        passingScore:
          row.passing_score !== null ? Number(row.passing_score) : 60,
        hasFailed,
        /*
         * The certificate for this course, or null. The card shows its
         * Certificate button ONLY when this is set — a completed course does
         * not imply one exists: a session training never auto-issues
         * (§10.7), and a revoked certificate is excluded by the query. A
         * button that led to a page not listing this course would be the
         * screen-that-lies failure §10.3.1.2 exists to prevent.
         */
        certificateId:
          row.certificate_id !== null ? Number(row.certificate_id) : null,
        course: {
          id: row.course_id,
          name: row.name,
          description: row.description,
          // The list cards show course art too, so the thumbnail has to reach
          // them — only the detail endpoint used to return it.
          thumbnail_url: row.thumbnail_url,
        },
        // Null for a catalog course. Present when this training IS a live or
        // in-person session, so the card can show when and where it is held
        // instead of a progress bar the learner cannot move themselves.
        session: this.sessionOf(row),
      };
    });

    const completed = courses.filter((c) => c.status === 'completed').length;
    const scores = courses
      .map((c) => c.bestScore)
      .filter((s): s is number => s !== null);

    const nextDeadline =
      courses
        .filter((c) => c.status !== 'completed')
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;

    return {
      overview: {
        totalAssigned: courses.length,
        inProgress: courses.filter((c) => c.status === 'in-progress').length,
        completed,
        assigned: courses.filter((c) => c.status === 'assigned').length,
        failed: courses.filter((c) => c.status === 'failed').length,
        avgScore: scores.length
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : null,
        nextDeadline: nextDeadline
          ? {
              short: nextDeadline.dueShort,
              courseName: nextDeadline.course.name,
            }
          : null,
      },
      /* `journeyPct` is GONE with the view that read it. It was the share of
         assigned courses completed, dressed up as a journey percentage on a
         "Learning Journey" tab that numbered an arbitrary list 1..N. A real
         path is an order an admin chose, and it lives in `journeys` with its
         own progress (§10.11). Two things called a journey, one of them not
         one, is how a learner stops believing either. */
      courses,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/dashboard
  ───────────────────────────────────────────── */

  async dashboard(scope: OrgScope, userId: number) {
    const [rows, standings, lessonMinutes, scormBuckets, attempts] =
      await Promise.all([
        this.repository.assignedCourses(scope, userId),
        this.leaderboard_.standings(scope),
        this.hours.lessonMinutes(scope, currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.hours.scormMinutes(scope, currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.repository.recentAttempts(scope, userId, 5),
      ]);

    const rewardOf = this.rewardMapper(rows);

    const enrolled = rows.map((row) => {
      const total = Number(row.total_lessons);
      const done = Number(row.completed_lessons);
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const isDone = total > 0 && done >= total;

      return {
        enrollment_id: row.enrollment_id,
        assigned_at: row.assigned_at,
        last_activity: row.last_activity ?? null,
        status: isDone ? 'completed' : done > 0 ? 'in-progress' : 'assigned',
        progress_percentage: pct,
        due_date: this.dueDateFor(row),
        session: this.sessionOf(row),
        reward: rewardOf(row),
        course: {
          id: row.course_id,
          name: row.name,
          description: row.description,
          thumbnail_url: row.thumbnail_url,
          total_lessons: total,
          completed_lessons: done,
        },
      };
    });

    // Points and rank come from the shared leaderboard calculation, so the
    // figure on the dashboard is the same one the leaderboard shows.
    const myStanding = standings.entries.find((e) => e.id === userId) ?? null;
    const points = myStanding?.points ?? 0;
    const rank = myStanding?.rank ?? standings.entries.length + 1;

    const minutes = lessonMinutes.find((row) => Number(row.user_id) === userId);
    const scorm = scormBuckets.get(userId);

    const [lessonEvents, assessmentEvents, assignmentEvents] = await Promise.all([
      this.repository.lessonEvents(scope, userId, 3),
      this.repository.assessmentEvents(scope, userId, 3),
      this.repository.assignmentEvents(scope, userId, 3),
    ]);

    const recentActivity = [
      ...lessonEvents.map((e) => ({
        type: 'lesson',
        title: e.title,
        course: e.course_name,
        time: e.event_time,
        time_label: relativeTime(e.event_time),
      })),
      ...assessmentEvents.map((e) => ({
        type: 'assessment',
        title: e.title,
        course: e.course_name,
        time: e.event_time,
        time_label: relativeTime(e.event_time),
        passed: Number(e.is_passed) === 1,
      })),
      ...assignmentEvents.map((e) => ({
        type: 'assignment',
        title: `Assigned: ${e.title}`,
        course: e.title,
        time: e.event_time,
        time_label: relativeTime(e.event_time),
      })),
    ]
      .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
      .slice(0, 8);

    const journey = enrolled
      .slice()
      .sort((a, b) => (a.assigned_at || '').localeCompare(b.assigned_at || ''))
      .map((c) => ({
        course_id: c.course.id,
        name: c.course.name,
        status: c.status,
        progress_percentage: c.progress_percentage,
      }));

    return {
      enrolled_courses: enrolled,
      stats: {
        assigned_courses: enrolled.length,
        in_progress_courses: enrolled.filter((c) => c.status === 'in-progress').length,
        completed_courses: enrolled.filter((c) => c.status === 'completed').length,
        yet_to_start: enrolled.filter((c) => c.status === 'assigned').length,
        hours_this_month: minutesToHours(Number(minutes?.this_month ?? 0)),
        hours_goal: MONTHLY_GOAL_HOURS,
        hours_all_time: minutesToHours(
          Number(minutes?.all_time ?? 0) + (scorm?.all ?? 0),
        ),
        completed_assessments: myStanding?.badges ?? 0,
      },
      points,
      rank,
      rank_of: standings.entries.length,
      badges: myStanding?.badges ?? 0,
      skill_tags: skillTags(enrolled.map((c) => c.course.name)).slice(0, 5),
      continue_learning:
        enrolled
          .filter((c) => c.status === 'in-progress')
          .sort((a, b) =>
            (b.last_activity || '').localeCompare(a.last_activity || ''),
          )[0] ?? null,
      journey: {
        courses: journey,
        completed: journey.filter((c) => c.status === 'completed').length,
        total: journey.length,
      },
      upcoming_deadlines: enrolled
        .filter((c) => c.status !== 'completed')
        .sort((a, b) => a.due_date.localeCompare(b.due_date))
        .slice(0, 4)
        .map((c) => ({
          course_id: c.course.id,
          name: c.course.name,
          due_date: c.due_date,
          status: c.status,
        })),
      recent_activity: recentActivity,
      recentAttempts: attempts,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/courses/:courseId
  ───────────────────────────────────────────── */

  async courseDetail(scope: OrgScope, userId: number, courseId: number) {
    const assignment = await this.repository.findAssignment(scope, userId, courseId);
    if (!assignment) {
      // 404, not 403. A 403 distinguishes "exists in another org but is not
      // yours" from "does not exist", which is exactly the existence oracle
      // §4.4 forbids — and the sibling lesson() path already returns 404.
      throw new NotFoundException('Course not found');
    }

    const course = await this.repository.findActiveCourse(courseId);
    if (!course) throw new NotFoundException('Course not found');

    const [modules, lessons, assessments, latestAttempts, assignedRows] =
      await Promise.all([
        this.repository.activeModules(courseId),
        this.repository.lessonsWithStatus(courseId, userId),
        this.repository.courseAssessments(courseId, userId),
        this.repository.latestAttemptsForCourse(courseId, userId),
        // Every assignment, not just this one: the badge nudge depends on how
        // many courses the learner has already finished, and the card on My
        // Courses is built from these same rows — reading them here is what
        // stops the two pages quoting different rewards for one course. It
        // runs alongside the others, so it costs no extra wait (§7.5).
        this.repository.assignedCourses(scope, userId),
      ]);

    const byModule = new Map<number, typeof lessons>();
    for (const lesson of lessons) {
      const key = Number(lesson.module_id);
      const list = byModule.get(key);
      if (list) list.push(lesson);
      else byModule.set(key, [lesson]);
    }

    let totalLessons = 0;
    let completedLessons = 0;
    // Sequential unlock: a module opens only once the previous one is finished,
    // and within a module each lesson opens once the previous is completed.
    let prevModuleComplete = true;

    const shapedModules = modules.map((module) => {
      const moduleLessons = byModule.get(Number(module.id)) ?? [];
      const locked = !prevModuleComplete;

      const withLocks = moduleLessons.map((lesson, index) => ({
        ...lesson,
        is_locked: locked
          ? true
          : index === 0
            ? false
            : moduleLessons[index - 1].progress_status !== 'completed',
      }));

      const completedCount = withLocks.filter(
        (l) => l.progress_status === 'completed',
      ).length;

      totalLessons += withLocks.length;
      completedLessons += completedCount;
      prevModuleComplete = !locked && completedCount === withLocks.length;

      return {
        ...module,
        lessons: withLocks,
        total_count: withLocks.length,
        completed_count: completedCount,
      };
    });

    const latestByAssessment = new Map(
      latestAttempts.map((a) => [
        Number(a.assessment_id),
        {
          percentage: a.percentage,
          is_passed: a.is_passed,
          submitted_at: a.submitted_at,
        },
      ]),
    );

    const progressPct =
      totalLessons > 0
        ? Math.round((completedLessons / totalLessons) * 100)
        : 0;

    const thisRow =
      assignedRows.find((r) => Number(r.course_id) === courseId) ?? null;

    return {
      course: {
        ...(course as Record<string, unknown>),
        modules_count: modules.length,
        lessons_count: totalLessons,
      },
      enrollment: {
        status: progressPct === 100 ? 'completed' : 'active',
        progress_percentage: progressPct,
        granted_at: assignment.assignedAt,
      },
      modules: shapedModules,
      assessments: assessments.map((a) => ({
        ...a,
        last_attempt: latestByAssessment.get(Number(a.id)) ?? null,
      })),
      assessmentsUnlocked: totalLessons > 0 && completedLessons === totalLessons,
      // Null only if the assignment vanished between the two reads, which the
      // 404 above has already ruled out for any realistic request.
      reward: thisRow ? this.rewardMapper(assignedRows)(thisRow) : null,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/lessons/:lessonId
  ───────────────────────────────────────────── */

  async lesson(scope: OrgScope, userId: number, lessonId: number) {
    const lesson = await this.repository.findLessonWithModule(scope, lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    if (!(await this.repository.isAssigned(scope, userId, Number(lesson.course_id)))) {
      throw new ForbiddenException('Access denied');
    }

    /**
     * A journey's sequence is enforced here, not only drawn in the UI.
     * Otherwise the lock is a CSS rule and the next course is one URL away.
     *
     * This only ever refuses a course the learner reached THROUGH a journey
     * (`source_journey_id` set). A course an admin assigned directly is open
     * regardless of where it sits in someone's path — spec §4.3.
     */
    await this.journeys.assertCourseUnlocked(scope, userId, Number(lesson.course_id));

    // One query gives every lesson in the course with its completion state,
    // which is enough to resolve both the lock check and the next-lesson link.
    // The resources come alongside it rather than after — they are needed on
    // the same render, so there is no reason to wait for one before the other.
    const [all, resources] = await Promise.all([
      this.repository.lessonsWithStatus(Number(lesson.course_id), userId),
      this.repository.lessonResources(lessonId),
    ]);

    const inModule = all.filter(
      (l) => Number(l.module_id) === Number(lesson.module_id),
    );
    const position = inModule.findIndex((l) => Number(l.id) === lessonId);

    if (position > 0) {
      if (inModule[position - 1].progress_status !== 'completed') {
        throw new ForbiddenException(
          'This lesson is locked. Complete the previous lesson first.',
        );
      }
    } else if (position === 0) {
      const moduleIds = [...new Set(all.map((l) => Number(l.module_id)))];
      const moduleIndex = moduleIds.indexOf(Number(lesson.module_id));
      if (moduleIndex > 0) {
        const prevId = moduleIds[moduleIndex - 1];
        const prev = all.filter((l) => Number(l.module_id) === prevId);
        const done = prev.filter(
          (l) => l.progress_status === 'completed',
        ).length;
        if (prev.length > 0 && done < prev.length) {
          throw new ForbiddenException(
            'This lesson is locked. Complete all lessons in the previous module first.',
          );
        }
      }
    }

    const flatIndex = all.findIndex((l) => Number(l.id) === lessonId);
    const next = flatIndex >= 0 ? all[flatIndex + 1] : undefined;
    const current = all[flatIndex];

    return {
      lesson: {
        id: lesson.id,
        title: lesson.title,
        description: lesson.description,
        content_type: lesson.content_type,
        content_url: lesson.content_url,
        // Booleans, not the R2 keys themselves: the player asks
        // GET /learner/lessons/:id/media for a signed URL when this is true.
        has_video: Boolean(lesson.video_key),
        has_captions: Boolean(lesson.caption_key),
        scorm_package_id: lesson.scorm_package_id ?? null,
        duration_minutes: lesson.duration_minutes,
        // Present when the lesson IS a document. The file itself is fetched
        // from GET /learner/lessons/:id/media, which signs it per request —
        // the storage key never reaches the browser.
        has_document: Boolean(lesson.document_key),
        document_name: lesson.document_name ?? null,
        document_mime: lesson.document_mime ?? null,
        document_size_bytes: lesson.document_size_bytes ?? null,
        module: { title: lesson.module_title },
        // Present only for a session lesson: there is nothing to play, so the
        // page shows when, where and with whom instead.
        session: lesson.session_id
          ? {
              id: Number(lesson.session_id),
              type: lesson.session_type,
              trainer: lesson.trainer,
              venue: lesson.venue_url,
              date: lesson.session_date,
              date_label: formatDate(lesson.session_date),
              start_time: lesson.start_time,
              end_time: lesson.end_time,
              status: displayStatus({
                status: lesson.session_status,
                date: lesson.session_date,
                start_time: lesson.start_time,
              }),
            }
          : null,
      },
      // Supporting material, listed alongside whatever the lesson's primary
      // content is. Reference only: resources carry no duration and never
      // reach learning hours, so the lesson still counts exactly once (§10.4).
      resources: resources.map((resource) => ({
        id: Number(resource.id),
        title: resource.title,
        resource_type: resource.resource_type,
        source: resource.source,
        file_name: resource.file_name,
        file_size_bytes: resource.file_size_bytes,
        mime_type: resource.mime_type,
        // A link is safe to hand over directly; an upload is not — it is
        // fetched from /learner/resources/:id/url on click.
        url: resource.source === 'link' ? resource.url : null,
      })),
      progress_status: current?.progress_status ?? 'not_started',
      next_lesson_id: next ? Number(next.id) : null,
    };
  }

  async completeLesson(scope: OrgScope, userId: number, lessonId: number) {
    const lesson = await this.repository.findLessonCourse(scope, lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    const courseId = Number(lesson.course_id);
    if (!(await this.repository.isAssigned(scope, userId, courseId))) {
      throw new ForbiddenException('Access denied');
    }

    // Attending a session is not something the learner can assert. The admin
    // marks the session completed, and attendance decides who is credited —
    // without this, any learner could POST here and award themselves the
    // training, its learning hours and its completion.
    if (lesson.content_type === 'session') {
      throw new ForbiddenException(
        'This training is completed by your trainer once the session has ' +
          'taken place.',
      );
    }

    // Enforce the journey sequence on the WRITE too. Gating only the lesson
    // read left the lock trivially bypassable: POST the completion directly
    // and the course completes, crediting hours, a certificate and the journey
    // itself (spec §4.3).
    await this.journeys.assertCourseUnlocked(scope, userId, courseId);

    await this.repository.markLessonComplete(scope, userId, lessonId);
    // Finishing the last lesson can complete the course, and completing the
    // course can complete a journey. All best-effort — a certificate, badge or
    // journey failure must never break marking a lesson complete (§8.4).
    await this.certificates.autoIssue(scope, userId, courseId);
    await this.badges.syncForBestEffort(scope, userId);
    await this.journeys.onCourseProgress(scope, userId, courseId);

    return { message: 'Lesson marked as complete' };
  }

  /* ─────────────────────────────────────────────
     Session trainings
  ───────────────────────────────────────────── */

  /**
   * A live session's deadline is the day it is held; every other course keeps
   * the generic window after assignment. Without this a session scheduled for
   * next week reported a due date a month out, and it stayed in "upcoming
   * deadlines" long after the sitting had passed.
   */
  private dueDateFor(row: {
    assigned_at: string;
    session_date?: string | null;
  }): string {
    return row.session_date || addDays(row.assigned_at, DUE_DAYS);
  }

  /** The session behind a training card, or null for a catalog course. */
  private sessionOf(row: {
    session_id?: number | null;
    session_type?: string | null;
    trainer?: string | null;
    venue_url?: string | null;
    session_department?: string | null;
    session_date?: string | null;
    session_start_time?: string | null;
    session_end_time?: string | null;
    session_status?: string | null;
  }) {
    if (!row.session_id) return null;

    return {
      id: Number(row.session_id),
      type: row.session_type ?? 'ILT',
      trainer: row.trainer ?? null,
      venue: row.venue_url ?? null,
      department: row.session_department ?? null,
      date: row.session_date ?? null,
      date_label: formatDate(row.session_date ?? ''),
      start_time: row.session_start_time ?? null,
      end_time: row.session_end_time ?? null,
      status: displayStatus({
        status: row.session_status,
        date: row.session_date,
        start_time: row.session_start_time,
      }),
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/progress
  ───────────────────────────────────────────── */

  async progress(scope: OrgScope, userId: number) {
    const [assigned, lessonProgress, scormRows, minutes, scormBuckets, attempts] =
      await Promise.all([
        this.repository.assignedCourses(scope, userId),
        this.repository.courseLessonProgress(scope, userId),
        this.repository.scormForAssignedCourses(scope, userId),
        this.hours.lessonMinutes(scope, currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.hours.scormMinutes(scope, currentMonthKey(), previousMonthKey(), monthWeeks()),
        this.repository.allAttempts(scope, userId),
      ]);

    const progressByCourse = new Map(
      lessonProgress.map((r) => [Number(r.course_id), r]),
    );

    const scormByCourse = new Map<number, typeof scormRows>();
    for (const row of scormRows) {
      const key = Number(row.course_id);
      const list = scormByCourse.get(key);
      if (list) list.push(row);
      else scormByCourse.set(key, [row]);
    }

    const courseHistory = assigned.map((course) => {
      const courseId = Number(course.course_id);
      const counts = progressByCourse.get(courseId);
      const total = Number(counts?.total ?? 0);
      const done = Number(counts?.done ?? 0);
      const scorm = scormByCourse.get(courseId) ?? [];

      let minutesSpent = Number(course.completed_minutes);
      let scormScore: number | null = null;
      let scormPassed: boolean | null = null;
      let partialBonus = 0;

      for (const row of scorm) {
        if (row.total_time) minutesSpent += parseScormDuration(row.total_time);

        if (row.score_raw !== null) {
          const raw = Number(row.score_raw);
          const max = row.score_max ? Number(row.score_max) : 100;
          const pct = max > 0 ? Math.round((raw / max) * 100) : raw;
          if (scormScore === null || pct > scormScore) scormScore = pct;
        }

        if (row.success_status === 'passed' || row.lesson_status === 'passed') {
          scormPassed = true;
        } else if (
          (row.success_status === 'failed' || row.lesson_status === 'failed') &&
          scormPassed !== true
        ) {
          scormPassed = false;
        }

        const isDone =
          row.completion_status === 'completed' ||
          row.lesson_status === 'passed' ||
          row.lesson_status === 'completed';
        if (!isDone && row.cmi_data && total > 0) {
          try {
            const cmi = JSON.parse(row.cmi_data) as { progress_measure?: string };
            const pm = parseFloat(String(cmi.progress_measure ?? 0));
            if (pm > 0) partialBonus += pm * (1 / total) * 100;
          } catch {
            /* malformed CMI blob — ignore the partial bonus */
          }
        }
      }

      const rawPct = total > 0 ? (done / total) * 100 + partialBonus : 0;
      const pct = Math.min(Math.round(rawPct), done >= total ? 100 : 99);

      const quizScore =
        course.best_score !== null ? Number(course.best_score) : null;
      const score = quizScore ?? scormScore;
      const hasPassed =
        course.has_passed !== null
          ? Number(course.has_passed) === 1
          : scormPassed;

      let status: string;
      if (done === 0 && partialBonus === 0) status = 'not started';
      else if (done < total) status = 'in progress';
      else if (hasPassed === false) status = 'failed';
      else status = 'completed';

      const h = Math.floor(minutesSpent / 60);
      const m = Math.round(minutesSpent % 60);

      return {
        id: courseId,
        name: course.name,
        type: scorm.length > 0 ? 'SCORM' : 'VIDEO',
        status,
        progress: pct,
        score,
        timeSpent: minutesSpent < 1 ? null : h > 0 ? `${h}h ${m}m` : `${m}m`,
        hasPassed,
        /* WHAT KIND of learning this is, so the caller can split the list
           without re-deriving the rule. `kind` is a partition and the
           precedence matches LearningHoursRepository.learningTypeExpr —
           session first, then path, then course — so the Learning History
           tabs and the hours breakdown agree about which bucket a row is
           in. They would drift the first time one of them was edited
           alone. */
        kind:
          course.session_id !== null
            ? 'session'
            : course.source_journey_id !== null
              ? 'path'
              : 'course',
        completedExternally: course.external_certification_id !== null,
        sessionType: course.session_type ?? null,
        sessionDate: course.session_date ?? null,
        sessionStatus: course.session_status ?? null,
        trainer: course.trainer ?? null,
        venue: course.venue_url ?? null,
      };
    });

    const mine = minutes.find((r) => Number(r.user_id) === userId);
    const scorm = scormBuckets.get(userId);
    const allTimeHours = round1(
      Number(mine?.all_time ?? 0) / 60 + (scorm?.all ?? 0) / 60,
    );
    const thisMonth = round1(
      Number(mine?.this_month ?? 0) / 60 + (scorm?.thisMonth ?? 0) / 60,
    );
    const lastMonth = round1(
      Number(mine?.last_month ?? 0) / 60 + (scorm?.lastMonth ?? 0) / 60,
    );

    const scores = courseHistory
      .map((c) => c.score)
      .filter((s): s is number => s !== null);

    const best = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      const key = `${attempt.course_name}::${attempt.assessment_title}`;
      const existing = best.get(key);
      if (!existing || Number(attempt.score) > Number(existing.score)) {
        best.set(key, attempt);
      }
    }

    const [
      lessonEvents,
      assessEvents,
      assignEvents,
      scormEvents,
      paths,
      hoursByPeriod,
    ] = await Promise.all([
      this.repository.lessonEvents(scope, userId, 5),
      this.repository.assessmentEvents(scope, userId, 5),
      this.repository.assignmentEvents(scope, userId, 100),
      this.repository.scormEvents(scope, userId, 5),
      /* The paths tab reads the SERVICE that owns learning paths, never a
         second query of its own (§3.2) — so what My Progress says about a
         path cannot disagree with the Learning Paths page itself. */
      this.journeys.listForLearner(scope, userId, { limit: 100 }),
      this.hours.learnerHoursTrend(scope, userId),
    ]);

    const timeline = [
      ...lessonEvents.map((e) => ({
        type: 'lesson', title: e.title, course: e.course_name, time: e.event_time,
        timeLabel: relativeTime(e.event_time), dateLabel: formatDate(e.event_time),
      })),
      ...assessEvents.map((e) => ({
        type: 'assessment', title: e.title, course: e.course_name, time: e.event_time,
        timeLabel: relativeTime(e.event_time), dateLabel: formatDate(e.event_time),
        passed: Number(e.is_passed) === 1,
      })),
      ...assignEvents.map((e) => ({
        type: 'assignment', title: `Assigned: ${e.title}`, course: e.title,
        time: e.event_time, timeLabel: relativeTime(e.event_time),
        dateLabel: formatDate(e.event_time),
      })),
      ...scormEvents.map((e) => ({
        type: 'scorm', title: e.title, course: e.course_name, time: e.event_time,
        timeLabel: relativeTime(e.event_time), dateLabel: formatDate(e.event_time),
        scormStatus: e.completion_status || e.lesson_status,
      })),
    ]
      .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
      .slice(0, 15);

    const completed = courseHistory.filter((c) => c.status === 'completed');
    const passedCount = attempts.filter(
      (a) => Number(a.is_passed) === 1,
    ).length;

    return {
      summary: {
        assigned: courseHistory.length,
        completed: completed.length,
        completionRate: courseHistory.length
          ? Math.round((completed.length / courseHistory.length) * 100)
          : 0,
        avgScore: scores.length
          ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
          : null,
        bestScore: scores.length ? Math.max(...scores) : null,
        allTimeHours,
      },
      courseHistory,
      assessmentPerformance: {
        avgScore: attempts.length
          ? Math.round(
              attempts.reduce((s, a) => s + Number(a.score), 0) / attempts.length,
            )
          : null,
        bestScore: attempts.length
          ? Math.max(...attempts.map((a) => Number(a.score)))
          : null,
        passRate: attempts.length
          ? Math.round((passedCount / attempts.length) * 100)
          : null,
        attempts: [...best.values()].map((a) => ({
          courseName: a.course_name,
          assessmentTitle: a.assessment_title,
          score: Number(a.score),
          passed: Number(a.is_passed) === 1,
        })),
      },
      learningHours: {
        thisMonth,
        lastMonth,
        allTime: allTimeHours,
        diff: round1(thisMonth - lastMonth),
        ...goalStatus(thisMonth),
      },
      /* The same rows the Courses tab shows, split by kind. Sessions and
         learning paths are NOT courses in this list for the reason
         TASTE §10.3.1.17 gives: a session's only honest progress is "wait
         for the day", and a path is a wrapper whose progress is its own
         steps. One list of all three would have to pick one vocabulary and
         be wrong for two of them. */
      learningHistory: {
        courses: courseHistory.filter((c) => c.kind === 'course'),
        paths: paths.journeys,
        sessions: courseHistory.filter((c) => c.kind === 'session'),
      },
      /* Hours, not minutes, and converted HERE rather than in the browser:
         every other figure this endpoint sends is already hours, and one
         payload carrying both units is how a chart ends up sixty times too
         tall. */
      hoursByPeriod: {
        weekly: periodHours(hoursByPeriod.weekly),
        monthly: periodHours(hoursByPeriod.monthly),
        quarterly: periodHours(hoursByPeriod.quarterly),
        yearly: periodHours(hoursByPeriod.yearly),
      },
      hoursByYear: yearlyHours(hoursByPeriod.yearly),
      skills: skillTags(completed.map((c) => c.name)),
      timeline,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/achievements
  ───────────────────────────────────────────── */

  async achievements(scope: OrgScope, userId: number) {
    const [standings, lessonEvents, passedEvents] = await Promise.all([
      this.leaderboard_.standings(scope),
      this.repository.lessonEvents(scope, userId, 10),
      this.repository.assessmentEvents(scope, userId, 100, true),
    ]);

    const myStanding = standings.entries.find((e) => e.id === userId) ?? null;
    const points = myStanding?.points ?? 0;
    const rank = myStanding?.rank ?? standings.entries.length + 1;

    // Persisted on award, never recomputed (spec §4.5) — `points` is passed in
    // so this does not re-run the leaderboard's own bulk query a second time.
    const { stats } = await this.badges.syncFor(scope, userId, points);
    const earned = await this.badges.earnedKeys(scope, userId);

    // The nine badges this page has always shown — the three journey
    // milestones (`journeysCompleted`) are new, and belong to the dedicated
    // `GET /learner/badges` endpoint instead of changing what this one has
    // always returned (spec: "keep the SAME response shape").
    const badges = BADGE_CATALOGUE.filter((def) => def.metric !== 'journeysCompleted').map(
      (def) => ({
        id: def.id,
        tier: toDisplayTier(def.tier),
        title: def.label,
        desc: def.description,
        icon: def.icon,
        earned: earned.has(def.id),
      }),
    );
    const next = badges.find((b) => !b.earned) ?? null;

    const pointsHistory = [
      ...lessonEvents.map((e) => ({
        activity: 'Lesson Completed',
        detail: e.title,
        course: e.course_name,
        date: formatDate(e.event_time),
        points: POINTS_PER_LESSON,
        type: 'lesson',
      })),
      ...passedEvents.map((e) => ({
        activity: 'Assessment Passed',
        detail: e.title,
        course: e.course_name,
        date: formatDate(e.event_time),
        points: POINTS_PER_PASSED_ASSESSMENT,
        type: 'assessment',
      })),
    ]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20);

    return {
      summary: {
        points,
        rank,
        rankOf: standings.entries.length,
        earnedCount: badges.filter((b) => b.earned).length,
      },
      badges,
      nextBadge: next ? { ...next, hint: badgeHint(BADGES[next.id], stats[BADGES[next.id].metric]) } : null,
      pointsHistory,
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/leaderboard
  ───────────────────────────────────────────── */

  async leaderboard(scope: OrgScope, userId: number) {
    const { byPoints, byMonth, recognition } = await this.leaderboard_.standings(scope);

    const decorate = (e: (typeof byPoints)[number]) => ({
      id: e.id,
      name: e.name,
      initials: initialsOf(e.firstName, e.lastName),
      dept: e.dept,
      color: avatarColor(e.name),
      allTimeRank: e.rank,
      monthRank: e.monthRank,
      allTimePoints: e.points,
      monthPoints: e.monthPoints,
      badges: e.badges,
      isYou: e.id === userId,
    });

    const allLearners = byPoints.map(decorate);
    const top3 = allLearners.slice(0, 3);
    const podium = [
      top3[1] ? { ...top3[1], podiumPos: 2 } : null,
      top3[0] ? { ...top3[0], podiumPos: 1 } : null,
      top3[2] ? { ...top3[2], podiumPos: 3 } : null,
    ].filter(Boolean);

    const withYou = (card: { id: number } | null) =>
      card ? { ...card, isYou: card.id === userId } : null;

    return {
      /* The rules, from the same constants the board pays out with
         (`modules/leaderboard/points.ts`). Sent rather than mirrored in the
         browser so the explanation cannot drift from the arithmetic. */
      pointRules: POINT_RULES,
      pointNotes: POINTS_NOTES,
      me: allLearners.find((l) => l.isYou) ?? null,
      recognition: {
        learnerOfMonth: withYou(recognition.learnerOfMonth),
        quickLearner: withYou(recognition.quickLearner),
        assessmentTopper: withYou(recognition.assessmentTopper),
      },
      podium,
      allLearners,
      departments: [
        'All Departments',
        ...new Set(byPoints.map((l) => l.dept).filter(Boolean)),
      ].sort((a, b) =>
        a === 'All Departments' ? -1 : b === 'All Departments' ? 1 : a.localeCompare(b),
      ),
      byMonth: byMonth.map(decorate),
    };
  }

  /* ─────────────────────────────────────────────
     GET /learner/learning-hours
  ───────────────────────────────────────────── */

  async learningHours(scope: OrgScope, userId: number) {
    const [me, profiles, minutes, scormBuckets, courseHours, contentRows] =
      await Promise.all([
      this.repository.findUser(scope, userId),
      this.repository.allLearnerProfiles(scope),
      this.hours.lessonMinutes(scope, currentMonthKey(), previousMonthKey(), monthWeeks()),
      this.hours.scormMinutes(scope, currentMonthKey(), previousMonthKey(), monthWeeks()),
      this.repository.monthlyHoursByCourse(scope, userId, currentMonthKey()),
      this.repository.courseContentTypes(scope, userId),
    ]);

    const myDept = me?.department || 'Unknown';
    const minutesByUser = new Map(
      minutes.map((row) => [Number(row.user_id), row]),
    );

    /** Total hours for a learner in a period, lessons + SCORM. */
    const hours = (
      id: number,
      pick: (row: (typeof minutes)[number]) => number,
      scormPick: (b: { all: number; thisMonth: number; lastMonth: number; weeks: number[] }) => number,
    ) => {
      const row = minutesByUser.get(id);
      const scorm = scormBuckets.get(id);
      const lessonMins = row ? Number(pick(row)) : 0;
      const scormMins = scorm ? scormPick(scorm) : 0;
      return round1((lessonMins + scormMins) / 60);
    };

    const thisMonth = hours(userId, (r) => r.this_month, (b) => b.thisMonth);
    const lastMonth = hours(userId, (r) => r.last_month, (b) => b.lastMonth);
    const allTime = hours(userId, (r) => r.all_time, (b) => b.all);
    const goal = goalStatus(thisMonth);
    const goalPct = goal.goalPct;

    /* The same four granularities My Progress draws, from the same service
       method (§10.27) — so a learner who checks one page against the other
       cannot find two different answers for the same week. */
    const trend = await this.hours.learnerHoursTrend(scope, userId);
    const now = referenceNow();
    const hoursByPeriod = {
      weekly: withGoals(periodHours(trend.weekly), 'weekly', now),
      monthly: withGoals(periodHours(trend.monthly), 'monthly', now),
      quarterly: withGoals(periodHours(trend.quarterly), 'quarterly', now),
      yearly: withGoals(periodHours(trend.yearly), 'yearly', now),
    };

    const peers = profiles
      .filter((p) => (p.department || 'Unknown') === myDept)
      .map((p) => {
        const tm = hours(Number(p.id), (r) => r.this_month, (b) => b.thisMonth);
        const gp = Math.min(Math.round((tm / MONTHLY_GOAL_HOURS) * 100), 100);
        return {
          id: Number(p.id),
          name: `${p.first_name} ${p.last_name}`,
          dept: p.department,
          thisMonth: tm,
          lastMonth: hours(Number(p.id), (r) => r.last_month, (b) => b.lastMonth),
          allTime: hours(Number(p.id), (r) => r.all_time, (b) => b.all),
          goalPct: gp,
          // The SAME four bands as the learner's own meter. A peer row used
          // to say "Close" at 60% while the summary said "On Track" at 50%,
          // so two figures on one page were scored on different scales.
          status: goalBand(gp),
          isYou: Number(p.id) === userId,
        };
      })
      .sort((a, b) => b.thisMonth - a.thisMonth || b.allTime - a.allTime);

    const myRank = peers.findIndex((p) => p.isYou) + 1;
    const depts = [
      ...new Set(profiles.map((p) => p.department || 'Unknown')),
    ].sort();

    const orgOverview = depts.map((dept) => {
      const members = profiles.filter(
        (p) => (p.department || 'Unknown') === dept,
      );
      let total = 0;
      let onTrack = 0;
      for (const member of members) {
        const h = hours(Number(member.id), (r) => r.this_month, (b) => b.thisMonth);
        total += h;
        if (h >= MONTHLY_GOAL_HOURS) onTrack++;
      }
      return {
        dept,
        totalHours: round1(total),
        avgHours: members.length ? round1(total / members.length) : 0,
        onTrack,
        total: members.length,
        isYourDept: dept === myDept,
      };
    });

    const weeklyTrend = monthWeeks().map((week, index) => {
      const entry: Record<string, string | number> = { week: week.label };
      for (const dept of depts) {
        const members = profiles.filter(
          (p) => (p.department || 'Unknown') === dept,
        );
        let total = 0;
        for (const member of members) {
          total += hours(
            Number(member.id),
            (r) => [r.w1, r.w2, r.w3, r.w4][index],
            (b) => b.weeks[index],
          );
        }
        entry[dept] = round1(total);
      }
      return entry;
    });

    /* Training-mode breakdown for this month. */
    const typesByCourse = new Map(
      contentRows.map((r) => [
        Number(r.course_id),
        (r.content_types || '').split(',').filter(Boolean),
      ]),
    );

    const modeMap: Record<string, number> = {};
    for (const row of courseHours) {
      const mode = modeOf(typesByCourse.get(Number(row.course_id)) ?? []);
      modeMap[mode] = (modeMap[mode] ?? 0) + Number(row.hrs);
    }
    const scormHours = round1((scormBuckets.get(userId)?.thisMonth ?? 0) / 60);
    if (scormHours > 0) {
      modeMap['eLearning / SCORM'] =
        (modeMap['eLearning / SCORM'] ?? 0) + scormHours;
    }
    const totalModeHours =
      Object.values(modeMap).reduce((s, v) => s + v, 0) || 1;

    return {
      summary: {
        thisMonth, lastMonth, allTime,
        // goalPct / goal / remaining / statusLabel all come from the one
        // definition (`goalStatus`), which My Progress reads too — the two
        // screens sit one click apart and must not disagree about whether
        // somebody has met their goal.
        ...goal,
        diff: round1(thisMonth - lastMonth),
        deptRank: myRank, deptTotal: peers.length, dept: myDept,
        gapToFirst:
          myRank === 1 ? 0 : Math.max(0, round1((peers[0]?.thisMonth ?? 0) - thisMonth)),
      },
      hoursByPeriod,
      weeklyTrend,
      depts,
      // Order by hours, not a fixed list — the modes are derived now, so a
      // hard-coded ordering would drop any mode not in it.
      modeBreakdown: Object.keys(modeMap)
        .filter((m) => modeMap[m] > 0)
        .sort((a, b) => modeMap[b] - modeMap[a])
        .map((mode) => ({
          mode,
          hours: round1(modeMap[mode]),
          pct: Math.round((modeMap[mode] / totalModeHours) * 100),
          // No colour: the client picks from the brand ramp. The hex values
          // that used to be here were off-palette (TASTE §10.1).
        })),
      deptPeers: peers,
      orgOverview,
    };
  }

  /* ─────────────────────────────────────────────
     POST /learner/change-password
  ───────────────────────────────────────────── */

  /*
   * changePassword moved to AuthService — see auth.controller.ts. Removed
   * rather than left unreachable: two copies of a password rule is exactly how
   * they come to disagree, and this one could no longer be called.
   */

  /**
   * `GET /api/learner/team` — the manager's Team Learning module.
   *
   * **The team is DIRECT REPORTS** (`users.manager_id`), not the caller's
   * department. `0033` records why the definition moved: a department is a
   * reporting dimension, not a team, so two managers in one department each
   * saw the other's people and neither could have a report outside it.
   *
   * Scope still comes from the caller's own row, never the request. A manager
   * with no reports sees an EMPTY team rather than a department or an
   * organization — a visible nothing beats a silent leak (§3.5).
   *
   * Hours come from `LearningHoursService`, not a second sum (§10.4), which
   * is what lets this page state a monthly figure that agrees with the
   * learner's own Learning Hours page.
   */
  async team(scope: OrgScope, userId: number) {
    const [rows, minutesByUser] = await Promise.all([
      this.repository.directReports(scope.organizationId, userId),
      this.hours.minutesByUser(scope),
    ]);

    if (rows.length === 0) {
      return {
        team: [],
        summary: {
          size: 0,
          completed: 0,
          inProgress: 0,
          notStarted: 0,
          coursesAssigned: 0,
          coursesCompleted: 0,
          completionPct: 0,
          avgScore: null,
          hoursThisMonth: 0,
          avgHoursPerMonth: 0,
          onTrackForHours: 0,
          monthlyHoursGoal: MONTHLY_HOURS_GOAL,
          needsAttention: 0,
          note:
            'Nobody reports to you yet. An admin sets a manager on each ' +
            'person from Manage Users, and they appear here as soon as ' +
            'they do.',
        },
        actions: [],
      };
    }

    const team = rows.map((r) => {
      const assigned = Number(r.assigned ?? 0);
      const completedCourses = Number(r.completed ?? 0);
      const totalLessons = Number(r.total_lessons ?? 0);
      const doneLessons = Number(r.done_lessons ?? 0);
      const progressPct =
        totalLessons > 0 ? Math.round((doneLessons / totalLessons) * 100) : 0;
      const mins = minutesByUser.get(Number(r.id));
      const hoursThisMonth = Math.round(((mins?.thisMonth ?? 0) / 60) * 10) / 10;

      /*
       * Three states, from the same definition the rest of the product uses
       * (§10.12's `statusOf`): finished everything assigned, started but not
       * finished, or opened nothing. Somebody with no assignment at all is
       * "not started" rather than a fourth state — they have nothing to do,
       * which is the manager's problem to fix, not a status to invent.
       */
      let status: 'completed' | 'in_progress' | 'not_started';
      if (assigned > 0 && totalLessons > 0 && doneLessons >= totalLessons) {
        status = 'completed';
      } else if (doneLessons > 0) {
        status = 'in_progress';
      } else {
        status = 'not_started';
      }

      return {
        id: Number(r.id),
        name: `${r.first_name} ${r.last_name}`,
        department: r.department,
        jobRole: r.job_role,
        status,
        coursesAssigned: assigned,
        coursesCompleted: completedCourses,
        progressPct,
        // Null, never 0: "no assessment taken" and "scored zero" are
        // different facts and must not render alike (§10.3.1.8).
        score: r.best_score !== null ? Math.round(Number(r.best_score)) : null,
        passed: Number(r.passes ?? 0) > 0,
        hoursThisMonth,
        hoursAllTime: Math.round(((mins?.all ?? 0) / 60) * 10) / 10,
        onTrackForHours: hoursThisMonth >= MONTHLY_HOURS_GOAL,
        lastActiveAt: r.last_active_at ?? null,
      };
    });

    const assigned = team.reduce((n, m) => n + m.coursesAssigned, 0);
    const completedCourses = team.reduce((n, m) => n + m.coursesCompleted, 0);
    const scored = team.filter((m) => m.score !== null);
    const hoursThisMonth =
      Math.round(team.reduce((n, m) => n + m.hoursThisMonth, 0) * 10) / 10;

    /*
     * ACTION REQUIRED — the panel that makes this page worth opening.
     *
     * Only things a manager can actually do something about, each naming the
     * person and the gap. An empty list renders as "nothing needs attention",
     * which is a claim worth making explicitly: an admin should be able to
     * tell it from a panel that failed to load (§10.3.1.11).
     */
    const actions = team
      .filter((m) => !m.onTrackForHours || m.status === 'not_started')
      .map((m) => ({
        userId: m.id,
        name: m.name,
        kind: m.status === 'not_started' && m.coursesAssigned > 0
          ? ('not_started' as const)
          : ('behind_hours' as const),
        detail:
          m.status === 'not_started' && m.coursesAssigned > 0
            ? `${m.name.split(' ')[0]} has not started ${m.coursesAssigned} assigned course${m.coursesAssigned === 1 ? '' : 's'}`
            : `${m.name.split(' ')[0]} at ${m.hoursThisMonth}h of ${MONTHLY_HOURS_GOAL}h goal`,
      }));

    return {
      team,
      summary: {
        size: team.length,
        completed: team.filter((m) => m.status === 'completed').length,
        inProgress: team.filter((m) => m.status === 'in_progress').length,
        notStarted: team.filter((m) => m.status === 'not_started').length,
        coursesAssigned: assigned,
        coursesCompleted: completedCourses,
        completionPct:
          assigned > 0 ? Math.round((completedCourses / assigned) * 100) : 0,
        // Averaged over the people who HAVE a score, not over the team — one
        // untested person would otherwise drag the average toward zero and
        // read as poor performance rather than missing data.
        avgScore:
          scored.length > 0
            ? Math.round(
                scored.reduce((n, m) => n + (m.score ?? 0), 0) / scored.length,
              )
            : null,
        hoursThisMonth,
        avgHoursPerMonth:
          team.length > 0
            ? Math.round((hoursThisMonth / team.length) * 10) / 10
            : 0,
        onTrackForHours: team.filter((m) => m.onTrackForHours).length,
        monthlyHoursGoal: MONTHLY_HOURS_GOAL,
        needsAttention: actions.length,
        note: null,
      },
      actions,
    };
  }

  /**
   * Prod one report about their learning — the mock's "Nudge".
   *
   * A notification, not an email: this product has no mail transport, and a
   * button that silently sends nothing would be worse than no button. The
   * manager is NAMED in it, unlike session feedback, because a nudge from
   * nobody is just nagging — the learner should know who is asking and can
   * reply to them in person.
   *
   * Refuses for anybody who is not their report, so the id in the path cannot
   * be swapped for a colleague's.
   */
  async nudge(
    scope: OrgScope,
    managerUserId: number,
    targetUserId: number,
    manager: { firstName?: string; lastName?: string; email?: string },
  ) {
    const reports = await this.repository.directReports(
      scope.organizationId,
      managerUserId,
    );
    const target = reports.find((r) => Number(r.id) === targetUserId);
    if (!target) {
      throw new NotFoundException('That person does not report to you');
    }

    const from = actorLabel(manager);
    void this.notifications.notify({
      organizationId: scope.organizationId,
      userIds: [targetUserId],
      type: 'manager_nudge',
      title: `${from} nudged you about your learning`,
      body: 'Your manager is checking in on your progress this month.',
      link: '/my-courses',
      subjectType: 'user',
      subjectId: managerUserId,
      actorName: from,
    });

    return { ok: true, nudged: `${target.first_name} ${target.last_name}` };
  }

  /**
   * The team report as a workbook, rebuilt from the same `team()` the screen
   * reads — so the file and the page can never disagree.
   */
  async teamWorkbook(
    scope: OrgScope,
    userId: number,
    manager: { firstName?: string; lastName?: string; email?: string },
  ) {
    const { team, summary } = await this.team(scope, userId);
    const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

    const summaryRows: (string | number)[][] = [
      ['Team size', summary.size],
      ['Completed', summary.completed],
      ['In progress', summary.inProgress],
      ['Not started', summary.notStarted],
      ['Course completion %', summary.completionPct],
      // An em dash, not a zero: nobody tested is not the same as everybody
      // scoring nothing.
      ['Average score %', summary.avgScore ?? '—'],
      ['Hours this month', summary.hoursThisMonth],
      ['On track for hours', `${summary.onTrackForHours} of ${summary.size}`],
      ['Needs attention', summary.needsAttention],
    ];

    const rows = team.map((m) => [
      m.name,
      m.department ?? '—',
      m.jobRole ?? '—',
      m.status.replace('_', ' '),
      m.coursesAssigned,
      m.coursesCompleted,
      m.progressPct,
      m.score ?? '—',
      m.score === null ? '—' : m.passed ? 'Yes' : 'No',
      m.hoursThisMonth,
      m.hoursAllTime,
      m.lastActiveAt ? String(m.lastActiveAt).slice(0, 10) : '—',
    ]);

    const buffer = this.spreadsheets.buildTeamWorkbook({
      managerName: actorLabel(manager),
      generatedAt,
      monthlyGoal: summary.monthlyHoursGoal,
      summary: summaryRows,
      rows,
    });

    return {
      buffer,
      filename: `Team_Report_${new Date().toISOString().slice(0, 10)}.xlsx`,
    };
  }

  /* ── helpers ── */

  private shortDate(iso: string): string {
    return parseTimestamp(iso).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
    });
  }
}
