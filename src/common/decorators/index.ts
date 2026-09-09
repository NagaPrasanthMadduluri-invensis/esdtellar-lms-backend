import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';

import type { Permission } from '@/common/permissions';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
  UserRole,
} from '../types/authenticated-request';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const PLATFORM_ADMIN_KEY = 'platformAdmin';
export const PERMISSIONS_KEY = 'permissions';

/**
 * Opts a route out of AuthGuard. Authentication is deny-by-default: AuthGuard is
 * registered globally, so a route is protected unless it says otherwise. That
 * inversion is the point — the legacy code repeated a `requireAuth` call in
 * every handler, and a forgotten call meant a silently public endpoint.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route to the given roles. Requires AuthGuard to have run. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Requires every listed permission (`specs/rbac.md` §4.1), enforced by
 * `PermissionsGuard`. ANDs with `@Roles()` when both are present.
 *
 * Throws 403, not 404 — and that differs from the tenancy rule on purpose. A
 * cross-tenant id must 404 because its existence is a secret; "you may not
 * manage roles" leaks nothing, the button simply is not yours.
 */
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Restricts a route to admins of the platform organization
 * (`role === 'admin' AND organizationId === platformOrgId`), enforced by
 * `PlatformAdminGuard` — never by an `if (role === ...)` branch inside a
 * handler. An org admin cannot mint a platform admin: they can only create
 * users within their own `OrgScope`.
 */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN_KEY, true);

/** Injects the verified JWT claims. Never populated from client-supplied data. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return data ? request.user?.[data] : request.user;
  },
);

/**
 * Injects the `OrgScope` minted by `TenantContextGuard`. Present on every
 * authenticated, non-`@Public()` request; `undefined` on a public route,
 * since there is no verified organization to scope to.
 */
export const CurrentScope = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrgScope | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.orgScope;
  },
);
