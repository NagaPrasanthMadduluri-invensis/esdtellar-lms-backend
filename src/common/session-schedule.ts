/**
 * A session's SITTINGS, derived once and read by every view (2026-11-24).
 *
 * A sitting is one batch, or the session itself when it has no batches. Each
 * runs from `start_date` to `end_date` (inclusive; equal for a one-day sitting)
 * between `start_time` and `end_time` on every one of those days, and has its
 * own capacity, registered count and seats left.
 *
 * The admin list, the learner's sessions, the trainer's sessions, the course
 * catalogue, the three training calendars and the session report all read this
 * shape, so a batch can never show 3 seats left on one screen and 4 on another.
 */
import { batchDisplayStatus, type BatchDisplayStatus } from './session-enrolment';

/** The most days one sitting may span; also bounds `dates` for the calendar. */
export const MAX_SITTING_DAYS = 62;

export interface SessionForSittings {
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
}

export interface BatchForSittings {
  id: number;
  batch_no: number;
  label: string | null;
  date: string | null;
  end_date?: string | null;
  start_time: string | null;
  end_time: string | null;
  capacity: number | null;
  status: string;
  roster_count: number;
  waitlist_count?: number;
  trainer_name?: string | null;
  /** The session date this batch runs on (0076). */
  session_date_id?: number | null;
}

export interface Sitting {
  /** Null for the session's own single sitting. */
  batch_id: number | null;
  batch_no: number | null;
  /** "Batch 2 · Morning", "Batch 1", or the session's own title. */
  name: string;
  label: string | null;
  start_date: string | null;
  end_date: string | null;
  /** Every date the sitting runs on, for the calendars. Empty while pending. */
  dates: string[];
  start_time: string | null;
  end_time: string | null;
  capacity: number;
  registered: number;
  available: number;
  is_full: boolean;
  waitlist: number;
  status: BatchDisplayStatus;
  trainer_name: string | null;
  /** Minutes per day times days. Null when the times are not set. */
  total_minutes: number | null;
  /** The session date this sitting runs on, for a day batch (0076). */
  session_date_id: number | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every date from `start` to `end` inclusive, as YYYY-MM-DD. A missing or
 * earlier end is a one-day sitting. Capped at MAX_SITTING_DAYS.
 */
export function datesBetween(start: string | null | undefined, end?: string | null): string[] {
  if (!start || !ISO.test(start)) return [];
  const from = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  let to = from;
  if (end && ISO.test(end)) {
    const t = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
    if (t > from) to = t;
  }
  const out: string[] = [];
  for (let d = from; d <= to && out.length < MAX_SITTING_DAYS; d += 86_400_000) {
    out.push(new Date(d).toISOString().slice(0, 10));
  }
  return out;
}

/** Minutes from start to end on one day ("09:00" to "12:30" is 210). */
export function dailyMinutes(start: string | null | undefined, end: string | null | undefined): number | null {
  const toMin = (t?: string | null) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const a = toMin(start);
  const b = toMin(end);
  if (a === null || b === null || b <= a) return null;
  return b - a;
}

/** Seats left, never negative. */
export function seatsLeft(capacity: number, registered: number): number {
  return Math.max(0, capacity - registered);
}

function sitting(input: {
  batch_id: number | null;
  batch_no: number | null;
  name: string;
  label: string | null;
  date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  capacity: number;
  registered: number;
  waitlist: number;
  status: BatchDisplayStatus;
  trainer_name: string | null;
  session_date_id?: number | null;
}): Sitting {
  const dates = datesBetween(input.date, input.end_date);
  const perDay = dailyMinutes(input.start_time, input.end_time);
  const available = seatsLeft(input.capacity, input.registered);
  return {
    batch_id: input.batch_id,
    batch_no: input.batch_no,
    name: input.name,
    label: input.label,
    start_date: dates[0] ?? null,
    end_date: dates.at(-1) ?? null,
    dates,
    start_time: input.start_time,
    end_time: input.end_time,
    capacity: input.capacity,
    registered: input.registered,
    available,
    is_full: input.capacity > 0 && available === 0,
    waitlist: input.waitlist,
    status: input.status,
    trainer_name: input.trainer_name,
    total_minutes: perDay === null || dates.length === 0 ? null : perDay * dates.length,
    session_date_id: input.session_date_id ?? null,
  };
}

/** "Batch 2 · Morning", or "Batch 2" with no label. */
export function batchName(batchNo: number, label: string | null | undefined): string {
  return label && label.trim() ? `Batch ${batchNo} · ${label.trim()}` : `Batch ${batchNo}`;
}

/**
 * The sittings of one session. With batches: one per batch, each with its own
 * capacity (falling back to the session's when the batch sets none). Without:
 * the session itself, as one sitting.
 */
export function buildSittings(session: SessionForSittings, batches: BatchForSittings[]): Sitting[] {
  if (batches.length === 0) {
    return [
      sitting({
        batch_id: null,
        batch_no: null,
        name: session.title,
        label: null,
        date: session.date,
        end_date: session.end_date ?? null,
        start_time: session.start_time,
        end_time: session.end_time,
        capacity: Number(session.capacity ?? 0),
        registered: Number(session.roster_count ?? 0),
        waitlist: Number(session.waitlist_count ?? 0),
        status: session.status === 'cancelled' || session.status === 'completed'
          ? (session.status as BatchDisplayStatus)
          : 'scheduled',
        trainer_name: session.trainer ?? null,
      }),
    ];
  }
  // A finished or cancelled session finishes or cancels every batch in it.
  const sessionFinal =
    session.status === 'cancelled' || session.status === 'completed'
      ? (session.status as BatchDisplayStatus)
      : null;
  return [...batches]
    .sort((a, b) =>
      String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')) ||
      String(a.start_time ?? session.start_time).localeCompare(String(b.start_time ?? session.start_time)) ||
      a.batch_no - b.batch_no)
    .map((b) =>
      sitting({
        batch_id: Number(b.id),
        batch_no: Number(b.batch_no),
        name: batchName(Number(b.batch_no), b.label),
        label: b.label,
        date: b.date,
        end_date: b.end_date ?? null,
        // A batch with no times of its own runs at the session's times.
        start_time: b.start_time ?? session.start_time,
        end_time: b.end_time ?? session.end_time,
        capacity: b.capacity ?? Number(session.capacity ?? 0),
        registered: Number(b.roster_count ?? 0),
        waitlist: Number(b.waitlist_count ?? 0),
        status: sessionFinal ?? batchDisplayStatus({ status: b.status, date: b.date }),
        trainer_name: b.trainer_name ?? session.trainer ?? null,
        session_date_id: b.session_date_id ?? null,
      }),
    );
}

/**
 * Places for the whole training, when a learner attends every date (0076):
 * per date, the sum over its open batches, then the TIGHTEST date. Also the
 * training's length: per date the longest batch, summed.
 */
export function seatsAcrossDates(sittings: readonly Sitting[]): { capacity: number; available: number; minutes: number } {
  const perDate = new Map<string, { capacity: number; available: number; minutes: number }>();
  for (const x of sittings) {
    if (x.status === 'cancelled') continue;
    const key = String(x.session_date_id ?? x.start_date ?? x.batch_id);
    const t = perDate.get(key) ?? { capacity: 0, available: 0, minutes: 0 };
    t.capacity += x.capacity;
    t.available += x.available;
    t.minutes = Math.max(t.minutes, x.total_minutes ?? 0);
    perDate.set(key, t);
  }
  const days = [...perDate.values()];
  if (days.length === 0) return { capacity: 0, available: 0, minutes: 0 };
  return {
    capacity: Math.min(...days.map((d) => d.capacity)),
    available: Math.min(...days.map((d) => d.available)),
    minutes: days.reduce((n, d) => n + d.minutes, 0),
  };
}

/* ── Session dates (0076) ──────────────────────────────────────────────── */

/** The most dates one session may have. */
export const MAX_SESSION_DATES = 62;

export type DateChange = 'postponed' | 'preponed';

/** Moving a date later postpones it, earlier prepones it, same is no change. */
export function dateChange(from: string, to: string): DateChange | null {
  if (from === to) return null;
  return to > from ? 'postponed' : 'preponed';
}

/** Valid YYYY-MM-DD dates, de-duplicated and in order. */
export function normaliseDates(dates: readonly string[]): string[] {
  const real = (d: string) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    // A round trip refuses a day that does not exist (31 February).
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  };
  return [...new Set(dates.filter((d) => ISO.test(d) && real(d)))].sort();
}

/**
 * The difference between the dates a session has and the dates the admin
 * wants. A date taken away and a date put in are PAIRED, in order, as one
 * move, so its batches, placements and attendance go with it and the move is
 * labelled postponed or preponed. Only the unmatched remainder is a real add
 * or delete.
 */
export function planSchedule(
  current: readonly string[],
  desired: readonly string[],
): { moves: { from: string; to: string; change: DateChange }[]; added: string[]; removed: string[] } {
  const want = new Set(desired);
  const have = new Set(current);
  const removed = [...have].filter((d) => !want.has(d)).sort();
  const added = [...want].filter((d) => !have.has(d)).sort();
  const pairs = Math.min(removed.length, added.length);
  const moves = removed.slice(0, pairs).map((from, i) => ({
    from,
    to: added[i],
    change: dateChange(from, added[i]) as DateChange,
  }));
  return { moves, added: added.slice(pairs), removed: removed.slice(pairs) };
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/**
 * A session's dates as a person writes them: "5th, 6th November and 2nd
 * December 2026". Days are grouped by month in order, and the year is said
 * once at the end, or after each month's group when the dates cross a year.
 * Used on certificates and in the reschedule email.
 */
export function formatSessionDates(dates: readonly string[]): string {
  const list = normaliseDates(dates);
  if (list.length === 0) return '';
  const groups: { year: number; month: number; days: number[] }[] = [];
  for (const d of list) {
    const year = Number(d.slice(0, 4));
    const month = Number(d.slice(5, 7)) - 1;
    const day = Number(d.slice(8, 10));
    const last = groups.at(-1);
    if (last && last.year === year && last.month === month) last.days.push(day);
    else groups.push({ year, month, days: [day] });
  }
  const crossesYears = groups.some((g) => g.year !== groups[0].year);
  const parts = groups.map((g) => {
    const text = `${g.days.map(ordinal).join(', ')} ${MONTHS[g.month]}`;
    return crossesYears ? `${text} ${g.year}` : text;
  });
  const joined = parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return crossesYears ? joined : `${joined} ${groups[0].year}`;
}

/** "5 Nov 2026", for one date in a list or a notification fact. */
export function shortDate(value: string): string {
  if (!ISO.test(value)) return value;
  return `${Number(value.slice(8, 10))} ${MONTHS[Number(value.slice(5, 7)) - 1].slice(0, 3)} ${value.slice(0, 4)}`;
}

/**
 * Whether a sitting is open to new bookings: scheduled (or pending a date, for
 * an admin placing people) and not cancelled or completed.
 */
export function sittingIsBookable(s: Pick<Sitting, 'status'>): boolean {
  return s.status === 'scheduled' || s.status === 'pending';
}
