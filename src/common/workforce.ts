/**
 * The workforce catalogues — job level and office location.
 *
 * THESE ARE CODE, for the same reason `permissions.ts` and `badges.ts` are:
 * a value means something only because something reads it. Both of these are
 * read by the Reports builder as a **filter dimension** and a **comparison
 * dimension**, and a filter is only useful if the set of values is small,
 * closed and shared by every row.
 *
 * That is the lesson from `users.job_role`, which is free text: the live
 * database holds 18 distinct job roles across 20 learners, so filtering by one
 * returns one person and comparing by it compares nothing. `department` works
 * as a dimension because its values happen to repeat; that is luck, not
 * design. These two do not rely on luck — the admin picks from the list, so
 * the values repeat by construction.
 *
 * There is deliberately no `job_levels` or `locations` TABLE. A table would
 * let an org invent a value, which is exactly what makes `job_role` useless,
 * and neither list carries any attribute beyond its own name. When a value
 * needs to be added, it is added here and reviewed — a one-line change.
 *
 * `client/lib/workforce.js` mirrors both lists so the dropdowns offer the same
 * options the API will accept. This file is what actually enforces it: the
 * DTOs validate against `JOB_LEVELS` / `LOCATIONS` with `@IsIn`.
 */

/**
 * Seniority bands, ordered most to least senior. The order is the order the
 * dropdown renders and the order a "by job level" comparison chart sorts its
 * bars in, so it is not alphabetical on purpose — alphabetical would put
 * Intern above Manager and make the chart read backwards.
 */
export const JOB_LEVELS = [
  'Executive',
  'Manager',
  'Senior',
  'Mid',
  'Junior',
  'Intern',
] as const;

export type JobLevel = (typeof JOB_LEVELS)[number];

/**
 * Office locations, plus `Remote`.
 *
 * These are the values already present in the live database, normalised.
 * Two corrections are folded into the list rather than added beside it:
 * `Banagalore` was a typo for `Bangalore`, and `Delhi` is spelled `Delhi NCR`
 * here because that is the catchment the business actually reports on.
 * `scripts/seed-history.mjs` rewrites both, so no row is left holding a value
 * the dropdown cannot offer — a row like that matches no filter and silently
 * disappears from every report, which is worse than a typo.
 */
export const LOCATIONS = [
  'Ahmedabad',
  'Bangalore',
  'Chennai',
  'Delhi NCR',
  'Hyderabad',
  'Kochi',
  'Mumbai',
  'Pune',
  'Remote',
] as const;

export type Location = (typeof LOCATIONS)[number];

/**
 * Legacy spellings -> the canonical value. Used by the normalising migration
 * and by the seed; not used on the write path, where the DTO simply rejects
 * anything not in `LOCATIONS`.
 */
export const LOCATION_ALIASES: Record<string, Location> = {
  Banagalore: 'Bangalore',
  Bengaluru: 'Bangalore',
  Delhi: 'Delhi NCR',
};
