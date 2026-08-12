/**
 * Fixed reference period.
 *
 * The learner analytics pages are pinned to June 2026 because that is where the
 * seed data lives — a live `new Date()` renders empty charts. Carried over from
 * the legacy handlers verbatim. Change here only, and only when the data stops
 * being seed data.
 */
export const THIS_MONTH = '2026-06';
export const LAST_MONTH = '2026-05';
export const TODAY = '2026-06-15';

export const MONTHLY_GOAL_HOURS = 10;
export const DUE_DAYS = 44;

/** Week boundaries used by the learner learning-hours trend. */
export const WEEKS = [
  { label: 'Jun W1', start: '2026-06-01', end: '2026-06-07' },
  { label: 'Jun W2', start: '2026-06-08', end: '2026-06-14' },
  { label: 'Jun W3', start: '2026-06-15', end: '2026-06-21' },
  { label: 'Jun W4', start: '2026-06-22', end: '2026-06-30' },
] as const;

/** Points model: 10 per lesson completed, 50 per assessment passed. */
export const POINTS_PER_LESSON = 10;
export const POINTS_PER_PASSED_ASSESSMENT = 50;

/** Synthetic per-course metadata — the schema has no such column. */
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

/** Parses an ISO 8601 duration ("PT1H30M45S") to minutes. SCORM stores time this way. */
export function parseIsoDuration(iso: string | null): number {
  if (!iso) return 0;
  const m = iso.match(
    /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/,
  );
  if (!m) return 0;
  return (
    parseFloat(m[1] || '0') * 60 +
    parseFloat(m[2] || '0') +
    parseFloat(m[3] || '0') / 60
  );
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Math.floor(
    (new Date(TODAY).getTime() - new Date(iso.replace(' ', 'T')).getTime()) /
      86_400_000,
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
  return new Date(iso.replace(' ', 'T')).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso.replace(' ', 'T'));
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
