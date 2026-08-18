/**
 * The reference period every hours figure is measured against.
 *
 * Defined here, once, because the learner and admin views used to derive it
 * separately — learner.constants hard-coded '2026-06' while analytics computed
 * it from a REFERENCE_DATE — and two derivations of "this month" is exactly how
 * two dashboards end up disagreeing.
 *
 * Pinned to June 2026 because that is where the seed data lives; a live
 * `new Date()` renders empty charts. Change here only, and only when the data
 * stops being seed data.
 */
export const THIS_MONTH = '2026-06';
export const LAST_MONTH = '2026-05';
export const TODAY = '2026-06-15';

/** Week boundaries for the hours trend. */
export const WEEKS = [
  { label: 'Jun W1', start: '2026-06-01', end: '2026-06-07' },
  { label: 'Jun W2', start: '2026-06-08', end: '2026-06-14' },
  { label: 'Jun W3', start: '2026-06-15', end: '2026-06-21' },
  { label: 'Jun W4', start: '2026-06-22', end: '2026-06-30' },
] as const;
