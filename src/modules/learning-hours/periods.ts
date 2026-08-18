/**
 * The reporting period every "this month" figure is measured against.
 *
 * These are FUNCTIONS, not constants, and that is the point. They used to be
 * hard-coded to June 2026 (where the seed data lives), so a lesson completed
 * today counted toward all-time totals but was invisible to every monthly
 * figure — the monthly goal, the weekly trend and Leader of the Month were
 * frozen in the past and could never advance. Computing per call also means a
 * long-running process rolls over correctly at midnight on the 1st, which a
 * value captured at boot would not.
 *
 * `setReferenceDate()` exists for demoing the seed data: point it at a date
 * inside the seeded period and every report behaves as if that were today.
 * The env read lives in config/configuration.ts (§9); this module only holds
 * what it is given.
 */

let referenceDate: string | null = null;

/** Overrides "now" for reporting. Null restores real time. */
export function setReferenceDate(iso: string | null): void {
  referenceDate = iso && !Number.isNaN(new Date(iso).getTime()) ? iso : null;
}

export function referenceNow(): Date {
  return referenceDate ? new Date(referenceDate) : new Date();
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dayKey(date: Date): string {
  return `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

export function thisMonth(): string {
  return monthKey(referenceNow());
}

export function lastMonth(): string {
  const now = referenceNow();
  return monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
}

export function today(): string {
  return dayKey(referenceNow());
}

export interface Week {
  label: string;
  start: string;
  end: string;
}

const MONTH_LABEL = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Four buckets covering the current month: days 1-7, 8-14, 15-21, and 22 to
 * the end. The last bucket absorbs the ragged tail so a 28- or 31-day month
 * still has exactly four, which is what the trend chart expects.
 */
export function weeks(): Week[] {
  const now = referenceNow();
  const year = now.getFullYear();
  const month = now.getMonth();
  const label = `${MONTH_LABEL[month]} `;
  const lastDay = new Date(year, month + 1, 0).getDate();

  const bounds: [number, number][] = [
    [1, 7],
    [8, 14],
    [15, 21],
    [22, lastDay],
  ];

  return bounds.map(([from, to], index) => ({
    label: `${label}W${index + 1}`,
    start: dayKey(new Date(year, month, from)),
    end: dayKey(new Date(year, month, to)),
  }));
}
