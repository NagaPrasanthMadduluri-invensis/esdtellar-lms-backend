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
  return [...batches]
    .sort((a, b) => a.batch_no - b.batch_no)
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
        status: batchDisplayStatus({ status: b.status, date: b.date }),
        trainer_name: b.trainer_name ?? session.trainer ?? null,
      }),
    );
}

/**
 * Whether a sitting is open to new bookings: scheduled (or pending a date, for
 * an admin placing people) and not cancelled or completed.
 */
export function sittingIsBookable(s: Pick<Sitting, 'status'>): boolean {
  return s.status === 'scheduled' || s.status === 'pending';
}
