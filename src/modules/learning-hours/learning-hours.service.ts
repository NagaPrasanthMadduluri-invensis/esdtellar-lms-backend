import { Injectable } from '@nestjs/common';

import { parseScormDuration } from '@/common/scorm-duration.util';
import type { OrgScope } from '@/database/org-scope';

import {
  currentPeriodStarts,
  lastMonth,
  referenceNow,
  thisMonth,
  weeks,
} from './periods';
import {
  LearningHoursRepository,
  type MinutesRow,
  type TruncUnit,
  type Week,
} from './learning-hours.repository';

/** Minutes in one calendar bucket, split into the three kinds of learning. */
export interface PeriodTypeMinutes {
  /** The bucket's first day, `YYYY-MM-DD`. */
  period: string;
  course: number;
  path: number;
  session: number;
  total: number;
}

/** The kinds this product can produce hours for, in the order they render. */
export const LEARNING_TYPES = ['course', 'path', 'session'] as const;
export type LearningType = (typeof LEARNING_TYPES)[number];

/** A bucket with the label an axis prints. */
export interface LabelledPeriod extends PeriodTypeMinutes {
  label: string;
}

export const GRANULARITIES = [
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * How many buckets each granularity shows at most.
 *
 * A cap, not a target — the axis is trimmed to the learner's real activity
 * first, so somebody who joined in March does not get nine empty months in
 * front of their first bar.
 */
const LIMITS: Record<Granularity, number> = {
  weekly: 8,
  monthly: 12,
  quarterly: 8,
  yearly: 5,
};

/** Minutes a learner accumulated, per period. */
export interface LearnerMinutes {
  all: number;
  thisMonth: number;
  lastMonth: number;
  weeks: number[];
  /** The current week / quarter / year, for the dashboard's period tile. */
  thisWeek: number;
  thisQuarter: number;
  thisYear: number;
}

/**
 * The single source of truth for learning hours.
 *
 * Both portals read this. They used to compute hours independently — the
 * learner view summed lesson durations plus SCORM time, while the admin
 * analytics summed lesson durations only — so the same learner showed two
 * different totals depending on who was looking. Anything that needs hours goes
 * through here now, so there is one definition to be right or wrong.
 *
 * Two content types report their own time and one does not:
 *   - video  -> measured watch seconds (lesson_video_progress)
 *   - SCORM  -> total_time reported by the package
 *   - other  -> the admin-declared duration_minutes, on completion
 */
/**
 * Reported SCORM time, capped at whatever the lesson — or the package's own
 * manifest — says the content is worth (BACKEND_STRUCTURE.md §10.4).
 *
 * A package that reports four hours for a thirty-minute module earns thirty. A
 * package whose worth nobody declared is still paid its reported time, because
 * there is nothing to cap against; that is the one gap the doc calls out.
 */
function cappedScormMinutes(row: {
  total_time: string | null;
  declared_minutes: number | null;
}): number {
  const reported = parseScormDuration(row.total_time);
  const declared =
    row.declared_minutes === null || row.declared_minutes === undefined
      ? null
      : Number(row.declared_minutes);
  if (declared === null || Number.isNaN(declared) || declared <= 0) {
    return reported;
  }
  return Math.min(reported, declared);
}

/**
 * The JS half of `date_trunc`, for the one source that arrives as a string.
 *
 * It has to agree with Postgres exactly or a single sitting splits across two
 * bars: `week` is therefore ISO — Monday-first — matching
 * `date_trunc('week', ...)`, not the Sunday-first week a naive `getDay()`
 * would give.
 */
function truncateIso(stamp: string | null, unit: TruncUnit): string {
  const day = String(stamp ?? '').slice(0, 10);
  if (day.length !== 10) return '';
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return '';
  const iso = (year: number, month: number, date: number) =>
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

  if (unit === 'year') return iso(y, 1, 1);
  if (unit === 'quarter') return iso(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  if (unit === 'month') return iso(y, m, 1);

  // ISO week: step back to Monday. getUTCDay() is 0 for Sunday, so Sunday
  // belongs to the week that STARTED six days earlier, not the one beginning
  // the next day.
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((weekday + 6) % 7));
  return date.toISOString().slice(0, 10);
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Re-buckets already-aggregated rows onto a coarser key. */
function foldPeriods(
  rows: PeriodTypeMinutes[],
  keyOf: (iso: string) => string,
): PeriodTypeMinutes[] {
  const out = new Map<string, PeriodTypeMinutes>();
  for (const row of rows) {
    const key = keyOf(row.period);
    const bucket = out.get(key) ?? {
      period: key,
      course: 0,
      path: 0,
      session: 0,
      total: 0,
    };
    bucket.course += row.course;
    bucket.path += row.path;
    bucket.session += row.session;
    bucket.total += row.total;
    out.set(key, bucket);
  }
  return [...out.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function stepPeriod(iso: string, unit: TruncUnit): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (unit === 'year') return isoDate(y + 1, 1, 1);
  if (unit === 'quarter') return m >= 10 ? isoDate(y + 1, 1, 1) : isoDate(y, m + 3, 1);
  if (unit === 'month') return m === 12 ? isoDate(y + 1, 1, 1) : isoDate(y, m + 1, 1);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
}

/**
 * A month and a week must not be able to read as each other.
 *
 * `Jun 26` was both "June 2026" on the monthly axis and "26 June" on the
 * weekly one, and nothing on either chart said which. The month keeps an
 * apostrophe and the week leads with the day, so the two shapes are
 * distinguishable at a glance without a legend.
 */
function labelFor(iso: string, unit: TruncUnit): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (unit === 'year') return String(y);
  if (unit === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (unit === 'month') return `${MONTH_ABBR[m - 1]} '${String(y).slice(2)}`;
  return `${d} ${MONTH_ABBR[m - 1]}`;
}

/**
 * A continuous, zero-filled, capped axis over whatever buckets carry data —
 * running through to TODAY.
 *
 * Gaps are filled rather than dropped: a learner who took August off should
 * see a bar at zero, not August missing and September sliding into its place.
 *
 * THE AXIS ALWAYS REACHES THE CURRENT PERIOD, even when the learner has done
 * nothing in it. It used to stop at their last activity, so somebody whose
 * last lesson was in July saw a page headed "July" through September — and a
 * goal page whose most prominent figure is two months stale is worse than
 * one showing an honest zero. "You have done nothing this month" is the
 * single most useful thing this page can say.
 *
 * The START is still the first real activity. §10.12's rule about not
 * padding an axis applies to LEADING emptiness — months before somebody
 * joined, which read as a collapse that never happened. A trailing gap is
 * the opposite: it is the learner's own recent silence, which is information.
 */
function axis(
  rows: PeriodTypeMinutes[],
  unit: TruncUnit,
  limit: number,
  through: string,
): LabelledPeriod[] {
  if (rows.length === 0) return [];
  const byPeriod = new Map(rows.map((r) => [r.period, r]));
  const first = rows[0].period;
  const lastWithData = rows[rows.length - 1].period;
  const last = through > lastWithData ? through : lastWithData;

  const out: LabelledPeriod[] = [];
  let cursor = first;
  // Bounded: the step always advances, and the guard stops a malformed date
  // from spinning. 600 covers fifty years of months.
  for (let i = 0; i < 600 && cursor <= last; i += 1) {
    const row = byPeriod.get(cursor);
    out.push({
      period: cursor,
      label: labelFor(cursor, unit),
      course: row?.course ?? 0,
      path: row?.path ?? 0,
      session: row?.session ?? 0,
      total: row?.total ?? 0,
    });
    const next = stepPeriod(cursor, unit);
    if (next <= cursor) break;
    cursor = next;
  }
  return out.slice(-limit);
}

@Injectable()
export class LearningHoursService {
  constructor(private readonly repository: LearningHoursRepository) {}

  /**
   * Lesson-side minutes per learner — measured video plus declared durations,
   * SCORM deliberately excluded (it is counted from its own reported time).
   */
  async lessonMinutes(
    scope: OrgScope,
    month: string = thisMonth(),
    previousMonth: string = lastMonth(),
    weekRanges: readonly Week[] = weeks(),
  ): Promise<MinutesRow[]> {
    return this.repository.minutesByUser(
      scope,
      month,
      previousMonth,
      weekRanges,
      currentPeriodStarts(),
    );
  }

  /** SCORM minutes per learner, parsed from whichever format the package used. */
  async scormMinutes(
    scope: OrgScope,
    month: string = thisMonth(),
    previousMonth: string = lastMonth(),
    weekRanges: readonly Week[] = weeks(),
  ): Promise<Map<number, LearnerMinutes>> {
    const rows = await this.repository.scormTimes(scope);
    const buckets = new Map<number, LearnerMinutes>();

    for (const row of rows) {
      // The lesson branch of `lessonSource` has already paid this package's
      // declared duration, so adding its reported time would pay the same
      // sitting twice (BACKEND_STRUCTURE.md §10.4). This is also what makes
      // re-launching a finished package earn nothing.
      if (row.credited_by_lesson) continue;

      const minutes = cappedScormMinutes(row);
      if (minutes === 0) continue;

      const key = Number(row.user_id);
      const entry = buckets.get(key) ?? LearningHoursService.empty();
      entry.all += minutes;

      const stamp = row.updated_at || '';
      const stampMonth = stamp.slice(0, 7);
      if (stampMonth === month) entry.thisMonth += minutes;
      if (stampMonth === previousMonth) entry.lastMonth += minutes;

      const day = stamp.slice(0, 10);
      weekRanges.forEach((week, index) => {
        if (day >= week.start && day <= week.end) entry.weeks[index] += minutes;
      });

      // The same three current-period buckets the lesson half now carries,
      // or the dashboard's quarter would silently be lesson-only while its
      // month included this residual — two tiles counting differently.
      const starts = currentPeriodStarts();
      if (day >= starts.week) entry.thisWeek += minutes;
      if (day >= starts.quarter) entry.thisQuarter += minutes;
      if (day >= starts.year) entry.thisYear += minutes;

      buckets.set(key, entry);
    }
    return buckets;
  }

  /**
   * Everything combined, per learner. This is what a caller wants unless it
   * needs the two halves separately.
   */
  async minutesByUser(
    scope: OrgScope,
    month: string = thisMonth(),
    previousMonth: string = lastMonth(),
    weekRanges: readonly Week[] = weeks(),
  ): Promise<Map<number, LearnerMinutes>> {
    const [lessonRows, scorm] = await Promise.all([
      this.lessonMinutes(scope, month, previousMonth, weekRanges),
      this.scormMinutes(scope, month, previousMonth, weekRanges),
    ]);

    const totals = new Map<number, LearnerMinutes>();
    for (const row of lessonRows) {
      totals.set(Number(row.user_id), {
        all: Number(row.all_time),
        thisMonth: Number(row.this_month),
        lastMonth: Number(row.last_month),
        weeks: [Number(row.w1), Number(row.w2), Number(row.w3), Number(row.w4)],
        thisWeek: Number(row.this_week ?? 0),
        thisQuarter: Number(row.this_quarter ?? 0),
        thisYear: Number(row.this_year ?? 0),
      });
    }

    for (const [userId, entry] of scorm) {
      const existing = totals.get(userId) ?? LearningHoursService.empty();
      existing.all += entry.all;
      existing.thisMonth += entry.thisMonth;
      existing.lastMonth += entry.lastMonth;
      existing.thisWeek += entry.thisWeek;
      existing.thisQuarter += entry.thisQuarter;
      existing.thisYear += entry.thisYear;
      entry.weeks.forEach((m, i) => { existing.weeks[i] += m; });
      totals.set(userId, existing);
    }

    return totals;
  }

  /**
   * All-time minutes per learner PER COURSE, keyed `userId:courseId`.
   *
   * What the exported report needs for its "Time Spent" column, which was a
   * literal em dash on every row before this existed. Reads the same two
   * halves as `minutesByUser` and combines them the same way, so a learner's
   * course rows add up to the total shown everywhere else.
   */
  async minutesByUserAndCourse(scope: OrgScope): Promise<Map<string, number>> {
    const [lessonRows, scormRows] = await Promise.all([
      this.repository.lessonMinutesByCourse(scope),
      this.repository.scormTimesByCourse(scope),
    ]);

    const totals = new Map<string, number>();
    const add = (userId: number, courseId: number, minutes: number) => {
      if (!minutes) return;
      const key = `${userId}:${courseId}`;
      totals.set(key, (totals.get(key) ?? 0) + minutes);
    };

    for (const row of lessonRows) {
      add(Number(row.user_id), Number(row.course_id), Number(row.minutes));
    }
    for (const row of scormRows) {
      // Same two rules as the per-learner shape, or the exported report's
      // "Time Spent" column would disagree with the learner's own total.
      if (row.credited_by_lesson) continue;
      add(Number(row.user_id), Number(row.course_id), cappedScormMinutes(row));
    }

    return totals;
  }

  /**
   * Minutes bucketed by calendar period, org-wide — for the admin Analytics
   * trend charts.
   *
   * A pass-through to the repository on purpose: there is no business rule to
   * apply here beyond the one already encoded in `lessonSource`, and putting
   * the bucketing in a service would tempt the next caller to bucket it
   * slightly differently. What this method DOES provide is the layer boundary
   * — `ReportsModule` reaches hours through this service and never through the
   * repository (§3.2), which is what keeps one definition of an hour.
   */
  async minutesByPeriod(scope: OrgScope, unit: TruncUnit) {
    return this.repository.minutesByPeriod(scope, unit);
  }

  /** The same minutes, split by derived mode of learning. */
  async minutesByPeriodAndMode(scope: OrgScope, unit: TruncUnit) {
    return this.repository.minutesByPeriodAndMode(scope, unit);
  }

  /** Per-learner minutes inside an arbitrary window — the Reports builder. */
  async minutesByUserInWindow(scope: OrgScope, from: string, to: string) {
    const rows = await this.repository.minutesByUserInWindow(scope, from, to);
    return new Map(
      rows.map((r) => [
        Number(r.user_id),
        { minutes: Number(r.minutes), allTime: Number(r.all_time) },
      ]),
    );
  }

  /**
   * ONE learner's minutes, bucketed by period and split by KIND of learning.
   *
   * Composed exactly the way `minutesByUserAndCourse` composes its two halves,
   * and for the same reason: lesson minutes alone are short of the figure the
   * rest of the product shows whenever a learner has SCORM time no lesson
   * completion has paid for. A breakdown that does not add up to the headline
   * beside it is the two-numbers failure §10.12 treats as an alarm, so the
   * residual is folded in here rather than left out and explained away.
   *
   * The SCORM half carries a timestamp but no calendar bucket — `total_time`
   * is a string Postgres cannot sum, which is the whole reason it is parsed in
   * a service — so its bucket is derived here from `updated_at` using the same
   * unit. `week` is ISO (Monday-first) on both sides because Postgres
   * `date_trunc('week')` is, and a JS-side week starting on Sunday would put
   * the two halves of one sitting in different bars.
   */
  async learnerHoursByPeriod(
    scope: OrgScope,
    userId: number,
    unit: TruncUnit,
  ): Promise<PeriodTypeMinutes[]> {
    const [lessonRows, scormRows] = await Promise.all([
      this.repository.learnerMinutesByPeriodAndType(scope, userId, unit),
      this.repository.learnerScormByType(scope, userId),
    ]);

    const buckets = new Map<string, PeriodTypeMinutes>();
    const at = (period: string) => {
      const existing = buckets.get(period);
      if (existing) return existing;
      const fresh: PeriodTypeMinutes = {
        period,
        course: 0,
        path: 0,
        session: 0,
        total: 0,
      };
      buckets.set(period, fresh);
      return fresh;
    };
    const add = (period: string, type: string, minutes: number) => {
      if (!minutes || !period) return;
      const bucket = at(period);
      const key: LearningType = (LEARNING_TYPES as readonly string[]).includes(
        type,
      )
        ? (type as LearningType)
        : 'course';
      bucket[key] += minutes;
      bucket.total += minutes;
    };

    for (const row of lessonRows) {
      add(
        String(row.period).slice(0, 10),
        row.learning_type,
        Number(row.minutes),
      );
    }

    for (const row of scormRows) {
      // Already paid by the lesson branch — adding it would pay one sitting
      // twice, the same rule `minutesByUser` and `minutesByUserAndCourse`
      // both apply.
      if (row.credited_by_lesson) continue;
      add(
        truncateIso(row.updated_at, unit),
        row.learning_type,
        cappedScormMinutes(row),
      );
    }

    return [...buckets.values()].sort((a, b) =>
      a.period.localeCompare(b.period),
    );
  }

  /**
   * The learner's own trend, at four granularities, split by kind.
   *
   * TWO QUERIES' WORTH OF UNITS, NOT FOUR. Quarters and years are FOLDED from
   * the monthly rows rather than re-truncated in SQL — §10.12 records why at
   * length for the admin axis, and the reason is the same one granularity
   * down: four `date_trunc` variants are four chances for a quarter to
   * disagree with the sum of its own months. Weeks cannot be folded from
   * months (a week straddles two), so that one is genuinely its own unit.
   *
   * Every bucket in the axis is present and zero-filled. A series shorter
   * than its axis shifts every remaining point one place left, which is the
   * worst way for a trend chart to be wrong.
   */
  async learnerHoursTrend(
    scope: OrgScope,
    userId: number,
  ): Promise<Record<Granularity, LabelledPeriod[]>> {
    const [weekly, monthly] = await Promise.all([
      this.learnerHoursByPeriod(scope, userId, 'week'),
      this.learnerHoursByPeriod(scope, userId, 'month'),
    ]);

    const quarterly = foldPeriods(monthly, (iso) => {
      const [y, m] = iso.split('-').map(Number);
      return isoDate(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
    });
    const yearly = foldPeriods(monthly, (iso) => isoDate(Number(iso.slice(0, 4)), 1, 1));

    // Where "now" falls on each axis, so every one of them reaches it.
    const today = referenceNow();
    const iso = isoDate(today.getFullYear(), today.getMonth() + 1, today.getDate());

    return {
      weekly: axis(weekly, 'week', LIMITS.weekly, truncateIso(iso, 'week')),
      monthly: axis(monthly, 'month', LIMITS.monthly, truncateIso(iso, 'month')),
      quarterly: axis(quarterly, 'quarter', LIMITS.quarterly, truncateIso(iso, 'quarter')),
      yearly: axis(yearly, 'year', LIMITS.yearly, truncateIso(iso, 'year')),
    };
  }

  /** The same minutes, per department. */
  async minutesByDepartment(scope: OrgScope) {
    return this.repository.minutesByDepartment(scope);
  }

  /** Zero-filled entry, so callers never branch on "this learner has none". */
  static empty(): LearnerMinutes {
    return {
      all: 0, thisMonth: 0, lastMonth: 0, weeks: [0, 0, 0, 0],
      thisWeek: 0, thisQuarter: 0, thisYear: 0,
    };
  }
}

export type { MinutesRow, Week };
