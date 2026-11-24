/**
 * Job-role fit for course recommendations (2026-11-24, owner request: "a
 * software engineer doesn't need the sales courses").
 *
 * Deterministic on purpose. The AI ranks and explains, but WHICH courses it may
 * choose from is decided here, so an off-role course can never be recommended
 * however the model behaves, and the rule is testable.
 *
 * 1. A learner's free-text Job role (falling back to their department) is read
 *    into one JOB FUNCTION by keyword.
 * 2. A course's name, Course tags, Skills and Category are read into the job
 *    functions it is BUILT FOR. A course built for none (Compliance, Soft
 *    Skills, Leadership, or a generic title) is for everyone.
 * 3. The fit of a course for a learner is:
 *      - `role`    built for their function;
 *      - `related` built for a neighbouring function (data <-> engineering);
 *      - `general` built for no function in particular;
 *      - `off`     built only for other functions: never recommended.
 * A learner whose role cannot be read gets no filtering (everything `general`):
 * guessing would hide good courses for no reason.
 */

export const JOB_FUNCTIONS = [
  'engineering',
  'data',
  'design',
  'sales',
  'marketing',
  'hr',
  'finance',
  'operations',
] as const;

export type JobFunction = (typeof JOB_FUNCTIONS)[number];

export type RoleFit = 'role' | 'related' | 'general' | 'off';

export const JOB_FUNCTION_LABELS: Record<JobFunction, string> = {
  engineering: 'Engineering',
  data: 'Data and analytics',
  design: 'Design',
  sales: 'Sales',
  marketing: 'Marketing',
  hr: 'People and HR',
  finance: 'Finance',
  operations: 'Operations',
};

/**
 * Keywords per function, matched as whole words (or word prefixes where they
 * end in `*`) on lower-cased text. Order matters only for the LEARNER, whose
 * role is read as the first function that matches: business functions come
 * before craft words, so "Sales Engineer" is sales, "Marketing Analyst" is
 * marketing and "Operations Analyst" is operations.
 */
const KEYWORDS: [JobFunction, string[]][] = [
  ['sales', ['sales', 'selling', 'sell', 'account executive', 'account manager', 'business development', 'bdr', 'sdr', 'presales', 'pre-sales', 'negotiat*', 'prospect*', 'crm', 'closing deals', 'quota']],
  ['marketing', ['marketing', 'marketer', 'seo', 'sem', 'brand*', 'content writer', 'copywrit*', 'social media', 'campaign*', 'growth marketing', 'digital marketing', 'advertis*', 'public relations']],
  ['hr', ['hr', 'human resource*', 'people operations', 'recruit*', 'talent acquisition', 'talent management', 'payroll', 'hiring', 'employee relations', 'compensation', 'hris']],
  ['finance', ['finance', 'financial', 'accountant', 'accounting', 'accounts', 'audit*', 'tax*', 'treasury', 'budget*', 'controller', 'bookkeep*', 'invoic*']],
  ['operations', ['operations', 'supply chain', 'logistics', 'procurement', 'warehouse', 'inventory', 'manufacturing', 'process improvement', 'lean', 'six sigma', 'vendor management']],
  ['design', ['design*', 'ux', 'ui', 'ui/ux', 'graphic*', 'video graphic*', 'illustrat*', 'animator', 'motion', 'creative', 'figma', 'visual design']],
  ['data', ['data', 'analyst*', 'analytics', 'business intelligence', 'bi', 'machine learning', 'statistic*', 'data scien*', 'visualisation', 'visualization', 'sql', 'excel', 'power bi', 'tableau']],
  ['engineering', ['engineer*', 'developer', 'software', 'programmer', 'programming', 'devops', 'sre', 'architect', 'web', 'frontend', 'front-end', 'backend', 'back-end', 'full stack', 'fullstack', 'cloud', 'python', 'java', 'javascript', 'coding', 'qa', 'tester', 'technology', 'it support', 'cyber*', 'security engineer']],
];

/** Functions close enough that a course for one is worth showing the other. */
const NEIGHBOURS: Record<JobFunction, JobFunction[]> = {
  engineering: ['data'],
  data: ['engineering'],
  design: ['marketing'],
  sales: ['marketing'],
  marketing: ['sales', 'design'],
  hr: [],
  finance: ['operations'],
  operations: ['finance'],
};

/**
 * Compliance is for everyone, whatever its wording: "Data Privacy" is not a
 * data course. Soft Skills and Leadership are for everyone UNLESS the title or
 * tags name a function ("Sales Negotiation" filed under Soft Skills is a sales
 * course).
 */
const UNIVERSAL_CATEGORIES = new Set(['compliance']);
const GENERAL_CATEGORIES = new Set(['soft skills', 'leadership']);

/**
 * Categories that name a function outright. HR is deliberately absent: the HR
 * category holds org-wide courses (DEI, POSH) as often as HR-team ones, so an
 * HR course is for HR staff only when its WORDS say so (recruiting, payroll).
 */
const CATEGORY_FUNCTION: Record<string, JobFunction> = {
  finance: 'finance',
  operations: 'operations',
};

/**
 * A title that names a cross-functional AUDIENCE ("... for Managers",
 * "... for everyone") is for that audience in every function, not for the
 * subject's own team: "Financial Fundamentals for Managers" is for any manager.
 */
const AUDIENCE_WIDE = /\bfor (?:all|everyone|every employee|all employees|managers|leaders|team leads|people managers|non-[a-z]+)\b/i;

const KEYWORD_PATTERNS: [JobFunction, RegExp][] = KEYWORDS.map(([fn, words]) => [
  fn,
  new RegExp(
    `(?<![a-z0-9])(?:${words
      .map((w) =>
        w.endsWith('*')
          ? `${escape(w.slice(0, -1))}[a-z]*`
          : escape(w),
      )
      .join('|')})(?![a-z0-9])`,
    'i',
  ),
]);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function functionsIn(text: string): JobFunction[] {
  const t = text.toLowerCase();
  return KEYWORD_PATTERNS.filter(([, re]) => re.test(t)).map(([fn]) => fn);
}

/**
 * The learner's job function, from their Job role, else their department.
 * The first match in KEYWORDS order wins. Null when neither says anything.
 */
export function jobFunctionOf(
  jobRole: string | null | undefined,
  department?: string | null,
): JobFunction | null {
  for (const text of [jobRole, department]) {
    if (!text || !text.trim()) continue;
    const found = functionsIn(text);
    if (found.length > 0) return found[0];
  }
  return null;
}

/**
 * The job functions a course is built for. Empty means "for everyone".
 * A universal Category (Compliance, Soft Skills, Leadership) always means
 * everyone: a "Data Privacy" compliance course is not a data course.
 */
export function courseFunctions(course: {
  name: string;
  category?: string | null;
  tags?: string | null;
  skills?: string[] | null;
}): JobFunction[] {
  const category = (course.category ?? '').trim().toLowerCase();
  if (UNIVERSAL_CATEGORIES.has(category)) return [];
  if (AUDIENCE_WIDE.test(course.name)) return [];
  // In a general category only the title and tags can make it functional;
  // a communication course whose skill list happens to say "Negotiation" is
  // still for everyone.
  const words = GENERAL_CATEGORIES.has(category)
    ? [course.name, course.tags ?? '']
    : [course.name, course.tags ?? '', ...(course.skills ?? [])];
  const found = new Set<JobFunction>(functionsIn(words.join(' | ')));
  const fromCategory = CATEGORY_FUNCTION[category];
  if (fromCategory) found.add(fromCategory);
  return JOB_FUNCTIONS.filter((fn) => found.has(fn));
}

/** How well a course fits a learner whose function is `fn` (see the header). */
export function roleFit(courseFns: JobFunction[], fn: JobFunction | null): RoleFit {
  if (courseFns.length === 0 || fn === null) return 'general';
  if (courseFns.includes(fn)) return 'role';
  if (courseFns.some((c) => NEIGHBOURS[fn].includes(c))) return 'related';
  return 'off';
}

const FIT_ORDER: Record<RoleFit, number> = { role: 0, related: 1, general: 2, off: 3 };

/**
 * Keep the courses worth recommending to this learner, best fit first, each
 * annotated with its fit. `off` courses are removed. Stable within a fit, so
 * the caller's own order (newest first) breaks ties.
 */
export function rankForRole<
  T extends { name: string; category?: string | null; tags?: string | null; skills?: string[] | null },
>(courses: T[], fn: JobFunction | null): (T & { roleFit: Exclude<RoleFit, 'off'> })[] {
  return courses
    .map((c, i) => ({ c, i, fit: roleFit(courseFunctions(c), fn) }))
    .filter((x): x is { c: T; i: number; fit: Exclude<RoleFit, 'off'> } => x.fit !== 'off')
    .sort((a, b) => FIT_ORDER[a.fit] - FIT_ORDER[b.fit] || a.i - b.i)
    .map(({ c, fit }) => ({ ...c, roleFit: fit }));
}
