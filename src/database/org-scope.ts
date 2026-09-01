import { sql, type SQL } from 'drizzle-orm';

declare const brand: unique symbol;

/**
 * A verified tenant scope. The branded field cannot be produced by an object
 * literal, so the ONLY way to obtain an `OrgScope` is `createOrgScope()` —
 * which in turn is only ever called by `TenantContextGuard`, from the
 * verified JWT. A request body, a query param, or a second cookie can never
 * become one (`BACKEND_STRUCTURE.md` §5.3 — the same rule already applied to
 * roles).
 */
export type OrgScope = {
  readonly organizationId: number;
  /**
   * The reserved platform organization. Carried on the scope rather than
   * injected separately so that every repository can widen a CONTENT read to
   * include global items without taking a dependency on OrganizationsService
   * (spec §3.4).
   */
  readonly platformOrganizationId: number;
  readonly [brand]: true;
};

/** The one function allowed to mint an `OrgScope`. */
export function createOrgScope(
  organizationId: number,
  platformOrganizationId: number,
): OrgScope {
  return { organizationId, platformOrganizationId } as OrgScope;
}

// A conservative whitelist for a SQL identifier used as a table alias. Not a
// sanitizer — a hard reject of anything that isn't a plain lowercase
// identifier, so an unexpected alias fails loudly instead of being
// interpolated unsafely.
const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * The org predicate, written once and reused everywhere a tenant-owned table
 * is queried — the same single-definition idiom as the shared `lessonSource`
 * fragment in `modules/learning-hours/learning-hours.repository.ts`.
 *
 * `alias` is validated against a strict identifier pattern rather than
 * interpolated as-is: it is always a literal string at the call site, never
 * request input, but this keeps that invariant enforced rather than assumed.
 */
export function orgScope(alias: string, scope: OrgScope): SQL {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(`orgScope: "${alias}" is not a safe SQL identifier`);
  }
  return sql`${sql.identifier(alias)}.organization_id = ${scope.organizationId}`;
}

/**
 * The predicate for a CONTENT table — one that may be owned by the platform
 * organization and shared with every tenant: courses, course_modules, lessons,
 * lesson_resources, assessments, assessment_questions, assessment_options and
 * scorm_packages (spec §3.4).
 *
 * Use `orgScope` for ACTIVITY tables instead. A learner's assignment,
 * completion, attempt, tracking row, certificate, roster entry or attendance
 * record always belongs to their own organization and is never global —
 * widening one of those would be a genuine cross-tenant leak, not a feature.
 *
 * The two functions are deliberately named differently rather than sharing one
 * with a boolean: which table is which is then greppable, and a reviewer can
 * check the choice at every call site instead of tracing an argument.
 *
 * `IN (org, platform)` rather than `= org OR IS NULL`: the sentinel keeps
 * organization_id NOT NULL everywhere, which is what makes the composite
 * foreign keys in §3.5 possible at all. Measured at the same cost (§3.4).
 */
export function contentScope(alias: string, scope: OrgScope): SQL {
  if (!SAFE_ALIAS.test(alias)) {
    throw new Error(`contentScope: "${alias}" is not a safe SQL identifier`);
  }
  return sql`${sql.identifier(alias)}.organization_id IN (${scope.organizationId}, ${scope.platformOrganizationId})`;
}
