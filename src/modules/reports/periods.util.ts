/**
 * Calendar bucketing for the admin Analytics page.
 *
 * WHY MONTHS ARE THE ONLY THING QUERIED. Every granularity here is built by
 * FOLDING monthly rows, not by issuing a differently-truncated query per
 * granularity. Five `date_trunc` variants would be five chances for the
 * quarterly total to disagree with the sum of its own months — and the fold is
 * arithmetic over at most sixty already-aggregated rows, which is not the
 * "aggregate in JavaScript" §7.2 warns about. That rule is about pulling rows
 * into Node to `.filter().length` them; the grouping still happens in SQL.
 */

export const GRANULARITIES = [
  'monthly',
  'quarterly',
  'half-yearly',
  'yearly',
  'multi-year',
] as const;

export type Granularity = (typeof GRANULARITIES)[number];

export interface Period {
  /** Stable identity, e.g. `2026-Q2`. Never shown to a reader. */
  key: string;
  /** What the axis prints, e.g. `Q2 2026`. */
  label: string;
  /** Inclusive month keys (`YYYY-MM`) this bucket folds. */
  months: string[];
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * How many buckets each granularity shows at most.
 *
 * A cap, not a target: the axis is trimmed to the data's real extent first
 * (see `buildPeriods`), so an organization with eight months of history gets
 * eight monthly bars rather than eighteen, twelve of them empty. An axis
 * padded with zeroes reads as a collapse in activity that never happened.
 */
const MAX_BUCKETS: Record<Granularity, number> = {
  monthly: 18,
  quarterly: 8,
  'half-yearly': 6,
  yearly: 5,
  'multi-year': 4,
};

/** Years folded into one bucket, per granularity. Only `multi-year` folds. */
const YEARS_PER_BUCKET = 2;

function monthKey(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

/** Every month key from `from` to `to`, inclusive. Both are `YYYY-MM`. */
function monthRange(from: string, to: string): string[] {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const out: string[] = [];
  let y = fy;
  let m = fm - 1;
  // Guard against a reversed or absurd range producing an unbounded loop.
  for (let guard = 0; guard < 1200; guard++) {
    const key = monthKey(y, m);
    out.push(key);
    if (y > ty || (y === ty && m >= tm - 1)) break;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return out;
}

function bucketFor(granularity: Granularity, month: string): { key: string; label: string } {
  const [y, m] = month.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  switch (granularity) {
    case 'monthly':
      return { key: month, label: `${MONTH_NAMES[m - 1]} ${y}` };
    case 'quarterly':
      return { key: `${y}-Q${q}`, label: `Q${q} ${y}` };
    case 'half-yearly': {
      const h = m <= 6 ? 1 : 2;
      return { key: `${y}-H${h}`, label: `H${h} ${y}` };
    }
    case 'yearly':
      return { key: `${y}`, label: `${y}` };
    case 'multi-year': {
      const start = Math.floor(y / YEARS_PER_BUCKET) * YEARS_PER_BUCKET;
      return { key: `${start}`, label: `${start}–${start + YEARS_PER_BUCKET - 1}` };
    }
  }
}

/**
 * The period axis for one granularity, trimmed to the data's real extent and
 * then to the granularity's cap.
 *
 * `firstActivity` and `lastActivity` are ISO dates or null. With no activity
 * at all the axis is the current bucket alone, so the page renders an empty
 * chart rather than crashing on an empty array.
 */
export function buildPeriods(
  granularity: Granularity,
  firstActivity: string | null,
  lastActivity: string | null,
  today = new Date(),
): Period[] {
  const nowKey = monthKey(today.getFullYear(), today.getMonth());
  const from = firstActivity ? firstActivity.slice(0, 7) : nowKey;
  // The axis never runs past today, even if a row is dated in the future.
  const rawTo = lastActivity ? lastActivity.slice(0, 7) : nowKey;
  const to = rawTo > nowKey ? nowKey : rawTo;
  const months = from <= to ? monthRange(from, to) : [nowKey];

  const byKey = new Map<string, Period>();
  for (const month of months) {
    const { key, label } = bucketFor(granularity, month);
    const existing = byKey.get(key);
    if (existing) existing.months.push(month);
    else byKey.set(key, { key, label, months: [month] });
  }

  const ordered = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  return ordered.slice(-MAX_BUCKETS[granularity]);
}

/**
 * Folds `YYYY-MM`-keyed values onto a period axis.
 *
 * Every bucket is present in the result, zero-filled — a chart whose series is
 * shorter than its axis silently shifts every remaining point one place left,
 * which is the worst possible way for a trend chart to be wrong.
 */
export function foldByPeriod(
  periods: Period[],
  rows: Iterable<{ period: string; value: number }>,
): Map<string, number> {
  const monthToBucket = new Map<string, string>();
  for (const p of periods) for (const m of p.months) monthToBucket.set(m, p.key);

  const out = new Map<string, number>(periods.map((p) => [p.key, 0]));
  for (const row of rows) {
    const bucket = monthToBucket.get(row.period.slice(0, 7));
    if (bucket === undefined) continue;
    out.set(bucket, (out.get(bucket) ?? 0) + row.value);
  }
  return out;
}

/**
 * The reporting window a Reports filter names, as inclusive ISO dates.
 *
 * `quarter` is the LAST COMPLETE calendar quarter, not the current one — the
 * reference labels it "Last quarter", and a quarter that is three days old is
 * not a period anybody wants to report on.
 */
export function reportWindow(
  key: string,
  today = new Date(),
): { from: string; to: string; label: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  if (key === 'month') {
    return {
      from: iso(new Date(Date.UTC(y, m, 1))),
      to: iso(new Date(Date.UTC(y, m + 1, 0))),
      label: `This month (${MONTH_NAMES[m]} ${y})`,
    };
  }
  if (key === 'quarter') {
    const currentQuarterStart = Math.floor(m / 3) * 3;
    const start = new Date(Date.UTC(y, currentQuarterStart - 3, 1));
    const end = new Date(Date.UTC(y, currentQuarterStart, 0));
    const q = Math.floor(start.getUTCMonth() / 3) + 1;
    return {
      from: iso(start),
      to: iso(end),
      label: `Last quarter (Q${q} ${start.getUTCFullYear()})`,
    };
  }
  if (key === 'year') {
    return {
      from: iso(new Date(Date.UTC(y, 0, 1))),
      to: iso(new Date(Date.UTC(y, 11, 31))),
      label: `This year (${y})`,
    };
  }
  return { from: '1970-01-01', to: iso(new Date(Date.UTC(y + 1, 0, 1))), label: 'All time' };
}

export const REPORT_WINDOWS = [
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'Last quarter' },
  { key: 'year', label: 'This year' },
  { key: 'all', label: 'All time' },
] as const;
