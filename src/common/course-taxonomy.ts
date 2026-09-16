/**
 * The course category catalogue.
 *
 * CODE, not data — the fourth catalogue in this codebase to be so
 * (`permissions.ts`, `badges.ts`, `workforce.ts`) and for the same reason:
 * a category means something only because something reads it. Here two things
 * do, and both would break on a free-text value:
 *
 *   - the Course Library filters and colours by category, and a colour map
 *     keyed on a string an admin typed has no entry for "complaince";
 *   - `Compliance` is LOAD-BEARING, not decorative. A compliance course is
 *     treated as mandatory whether or not the flag is set, and it is the only
 *     category where a renewal cadence means anything. That rule cannot hang
 *     off a string somebody might spell differently.
 *
 * `CATEGORY_COLORS` is the server's copy of a presentation concern on purpose:
 * the same seven colours are wanted by the exported report and any future
 * emailed digest, and duplicating them per surface is how they drift. The
 * browser mirrors this file at `client/lib/course-taxonomy.js`.
 */

export const COURSE_CATEGORIES = [
  'Soft Skills',
  'Technical',
  'Leadership',
  'Compliance',
  'Finance',
  'Operations',
  'HR',
] as const;

export type CourseCategory = (typeof COURSE_CATEGORIES)[number];

/**
 * The one category with behaviour attached. Kept as a named constant so the
 * rule is greppable rather than a string literal repeated in four services.
 */
export const COMPLIANCE_CATEGORY: CourseCategory = 'Compliance';

/**
 * Renewal cadence is offered only in whole months, and only these. A free
 * integer invites `1` and `999`; a compliance course that renews monthly is
 * not a training programme, and one that renews in 83 years does not renew.
 */
export const RENEWAL_MONTHS = [3, 6, 12, 18, 24, 36] as const;

export type RenewalMonths = (typeof RENEWAL_MONTHS)[number];

/**
 * A course is mandatory if it says so, OR if it is compliance.
 *
 * The second half is the whole point: an admin who files a course under
 * Compliance has already said it is not optional, and making them tick a
 * second box is how a compliance course ends up not marked mandatory. One
 * function so every surface — card ribbon, KPI count, report — agrees.
 */
export function isMandatory(course: {
  isMandatory?: number | boolean | null;
  category?: string | null;
}): boolean {
  if (course.category === COMPLIANCE_CATEGORY) return true;
  return Number(course.isMandatory ?? 0) === 1 || course.isMandatory === true;
}
