import type { Request } from 'express';

import type { Permission, RoleScope } from '@/common/permissions';
import type { OrgScope } from '@/database/org-scope';

/**
 * The portal selector. Three values since `specs/rbac.md` decision 6 gave the
 * trainer a portal of his own; a manager deliberately has no value here and
 * rides in `learner` (decision 2, §3.1.1).
 *
 * This is NOT the permission vocabulary — that lives in `common/permissions.ts`
 * and reaches a request as the `permissions[]` claim.
 */
export type UserRole = 'admin' | 'learner' | 'trainer';

/**
 * The verified JWT claims. `userId` is the `users.id` primary key — the legacy
 * code named this claim `userId` (never `id`) and route handlers relied on it,
 * so the name is preserved.
 *
 * `organizationId` was added by the multi-tenancy migration (spec §4.1). A
 * token signed before that migration has no such claim, and `TokenService.verify`
 * rejects it outright — there is no org a stale token could safely default to.
 */
export interface JwtPayload {
  userId: number;
  role: UserRole;
  email: string;
  firstName: string;
  lastName: string;
  organizationId: number;
  /**
   * The role row carrying this user's permissions and row scope, and the
   * permissions themselves — `specs/rbac.md` §3.6. Carried in the token so a
   * permission check costs no query.
   */
  roleId: number | null;
  permissions: Permission[];
  scope: RoleScope;
  /**
   * The organization's `perm_version` at signing time. `AuthGuard` compares it
   * to the current value and rejects a stale token, which is how "a permission
   * change forces a re-login" is delivered — scoped to the organization whose
   * roles changed, and no other.
   */
  permVersion: number;
  /**
   * This user's own token version. Bumped when they are moved to a different
   * role, so that change signs out only them — where `permVersion` above is
   * the organization's and signs out everyone.
   */
  userPermVersion: number;
  /**
   * Set ONLY on a support-session token, minted by
   * `POST /api/auth/impersonate` so a platform admin can work inside a
   * tenant's account.
   *
   * The token carries the TENANT USER's identity — their `userId`,
   * `organizationId`, role and permissions — so every query behaves exactly
   * as if that person had logged in, and nothing downstream has to learn
   * about impersonation. These two claims are what say the session is not
   * really theirs:
   *
   *   * `PlatformAdminGuard` refuses every platform route while they are set,
   *     so a support session cannot reach billing or another tenant;
   *   * the admin shell renders a permanent banner off them, because the one
   *     genuinely dangerous outcome is a super admin forgetting whose account
   *     they are in;
   *   * `POST /api/auth/exit-impersonation` reads `impersonatorId` to get
   *     back — and re-checks that the person is still a platform admin rather
   *     than trusting the claim.
   *
   * A support token is deliberately short-lived (`IMPERSONATION_TTL_SECONDS`)
   * rather than carrying the normal multi-day lifetime.
   */
  impersonatorId?: number;
  impersonatorName?: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

/** What `@CurrentUser()` hands to a controller. */
export type AuthenticatedUser = Omit<JwtPayload, 'exp'>;

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
  /**
   * Minted by `TenantContextGuard` from `user.organizationId` on every
   * authenticated, non-`@Public()` request. Never set from client input —
   * see `database/org-scope.ts`.
   */
  orgScope?: OrgScope;
}
