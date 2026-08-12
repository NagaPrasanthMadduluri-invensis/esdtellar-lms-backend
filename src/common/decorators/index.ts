import {
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from '@nestjs/common';

import type {
  AuthenticatedRequest,
  AuthenticatedUser,
  UserRole,
} from '../types/authenticated-request';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/**
 * Opts a route out of AuthGuard. Authentication is deny-by-default: AuthGuard is
 * registered globally, so a route is protected unless it says otherwise. That
 * inversion is the point — the legacy code repeated a `requireAuth` call in
 * every handler, and a forgotten call meant a silently public endpoint.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restricts a route to the given roles. Requires AuthGuard to have run. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Injects the verified JWT claims. Never populated from client-supplied data. */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return data ? request.user?.[data] : request.user;
  },
);
