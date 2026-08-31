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
  readonly [brand]: true;
};

/** The one function allowed to mint an `OrgScope`. */
export function createOrgScope(organizationId: number): OrgScope {
  return { organizationId } as OrgScope;
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
