import type { Request } from 'express';

import type { OrgScope } from '@/database/org-scope';

export type UserRole = 'admin' | 'learner';

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
