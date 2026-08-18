/**
 * Fixed reference period.
 *
 * The learner analytics pages are pinned to June 2026 because that is where the
 * seed data lives — a live `new Date()` renders empty charts. Carried over from
 * the legacy handlers verbatim. Change here only, and only when the data stops
 * being seed data.
 */
import { today } from '@/modules/learning-hours/periods';

export { thisMonth, lastMonth, today, weeks } from '@/modules/learning-hours/periods';

export const MONTHLY_GOAL_HOURS = 10;
export const DUE_DAYS = 44;

/** Points model: 10 per lesson completed, 50 per assessment passed. */
export const POINTS_PER_LESSON = 10;
export const POINTS_PER_PASSED_ASSESSMENT = 50;

/**
 * Delivery mode, derived from what a course actually contains.
 *
 * SCORM wins when present because it is the most specific thing a course can
 * hold; otherwise video, then documents, then anything else. Colours are NOT
 * returned — the client picks them from the brand ramp (TASTE §10.4), which is
 * why the old hex values here were both wrong and off-palette.
 */
export function modeOf(contentTypes: string[]): string {
  const types = new Set(contentTypes.map((t) => (t || '').toLowerCase()));
  if (types.has('scorm')) return 'eLearning / SCORM';
  if (types.has('video')) return 'Video / Self-paced';
  if (types.has('pdf')) return 'Reading / Documents';
  if (types.has('quiz')) return 'Assessment';
  return 'Other';
}

/** The dominant content type for a course card, from the same source. */
export function contentTypeOf(contentTypes: string[]): string {
  const types = new Set(contentTypes.map((t) => (t || '').toLowerCase()));
  if (types.has('scorm')) return 'SCORM';
  if (types.has('video')) return 'VIDEO';
  if (types.has('pdf')) return 'PDF';
  if (types.has('quiz')) return 'QUIZ';
  return 'MIXED';
}

/** Legacy synthetic metadata — retained only for the MODE_ORDER listing. */
export const COURSE_MODE: Record<number, { mode: string; color: string }> = {
  1: { mode: 'eLearning / SCORM', color: '#f59e0b' },
  2: { mode: 'Video / Self-paced', color: '#10b981' },
  3: { mode: 'VILT – Virtual Live', color: '#6366f1' },
  4: { mode: 'ILT – In-Person', color: '#374151' },
};

export const MODE_ORDER = [
  'ILT – In-Person',
  'VILT – Virtual Live',
  'Webinar',
  'eLearning / SCORM',
  'Video / Self-paced',
];

export const SKILL_MAP: [string, string][] = [
  ['project management', 'Project Mgmt'],
  ['agile', 'Agile'],
  ['scrum', 'Scrum'],
  ['ai for', 'AI'],
  ['banking', 'Finance'],
  ['leadership', 'Leadership'],
  ['communication', 'Communication'],
];

export const AVATAR_COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1',
];

/* ── Shared helpers ── */

export { parseScormDuration } from '@/common/scorm-duration.util';

/**
 * Parses a timestamp as it arrives from the database.
 *
 * Postgres renders `timestamptz` as `2026-08-17 12:34:56.789+00` — a space
 * separator and a *two-digit* UTC offset. That offset is not valid ISO 8601, so
 * rewriting the space to a `T` puts V8 into strict ISO mode and yields an
 * Invalid Date. Left alone, V8's non-ISO parser reads the string correctly.
 *
 * SQLite stored `2026-08-17 12:34:56` with no offset at all, where the `T`
 * rewrite was what made it parse — hence the swap this replaces. Plain
 * `YYYY-MM-DD` values (see `addDays`) parse correctly here too.
 */
export function parseTimestamp(iso: string): Date {
  return new Date(iso);
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Math.floor(
    (new Date(today()).getTime() - parseTimestamp(iso).getTime()) / 86_400_000,
  );
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return `${diff} days ago`;
  if (diff < 30) {
    const w = Math.floor(diff / 7);
    return `${w} week${w > 1 ? 's' : ''} ago`;
  }
  const mo = Math.floor(diff / 30);
  return `${mo} month${mo > 1 ? 's' : ''} ago`;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  return parseTimestamp(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function addDays(iso: string, days: number): string {
  const d = parseTimestamp(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function minutesToHours(minutes: number): number {
  return round1(Number(minutes) / 60);
}

export function skillTags(names: string[]): string[] {
  const tags = new Set<string>();
  for (const name of names) {
    const lower = (name || '').toLowerCase();
    for (const [key, tag] of SKILL_MAP) if (lower.includes(key)) tags.add(tag);
  }
  return [...tags];
}

export function initialsOf(first: string, last: string): string {
  return `${(first || '')[0] ?? ''}${(last || '')[0] ?? ''}`.toUpperCase();
}

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
