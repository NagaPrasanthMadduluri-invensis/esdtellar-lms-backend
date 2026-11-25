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
export const ANY_PERMISSIONS_KEY = 'anyPermissions';
export const ALLOW_BEFORE_MFA_KEY = 'allowBeforeMfa';

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
 * `PermissionsGuard`. ANDs with `@Roles()` when both are present, with one
 * exception: on an `@Roles('admin')` route, a learner- or trainer-portal caller
 * whose role was GIVEN these permissions passes `RolesGuard` too, so an extra
 * permission ticked for a Manager actually works (§10.65).
 *
 * Throws 403, not 404 — and that differs from the tenancy rule on purpose. A
 * cross-tenant id must 404 because its existence is a secret; "you may not
 * manage roles" leaks nothing, the button simply is not yours.
 */
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Opens an admin route that carries no `@Permissions()` (a shared content
 * read: the course list, a session, a learning path) to a caller from ANOTHER
 * portal who holds at least one of the listed permissions. Enforced by
 * `RolesGuard` + `PermissionsGuard` (BACKEND_STRUCTURE §10.65).
 *
 * An admin-portal caller is unaffected: content reads stay open to every
 * admin-portal role, exactly as before. The decorator exists for the
 * cross-portal grant: a Manager whose role is given `assign_learning` lands
 * in the learner portal but must be able to list courses in order to assign
 * one, while a plain learner, holding none of them, still gets 403.
 *
 * A route WITH `@Permissions()` needs nothing extra: holding that permission
 * already opens it to every portal.
 */
export const CrossPortal = (...permissions: Permission[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);

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

/**
 * Lets an admin who has NOT yet set up two-step sign-in reach this route
 * (MfaEnrolmentGuard). Only what the setup page itself needs carries it: who
 * am I, set up / enable two-step, the notice acknowledgement, sign out.
 */
export const AllowBeforeMfa = () => SetMetadata(ALLOW_BEFORE_MFA_KEY, true);
