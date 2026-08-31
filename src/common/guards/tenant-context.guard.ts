import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { createOrgScope } from '@/database/org-scope';

import { IS_PUBLIC_KEY } from '../decorators';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Registered globally, running AFTER `AuthGuard` and `RolesGuard` so
 * `request.user` is already populated and any role check has already run.
 * Mints the request's `OrgScope` from the verified JWT's `organizationId`
 * claim — never from a body, query param, or header (`BACKEND_STRUCTURE.md`
 * §5.3, the same rule already applied to roles).
 *
 * Skipped for `@Public()` routes: there is no verified user to scope to, and
 * `request.orgScope` is left `undefined` for them.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // AuthGuard already rejected the request if `user` were missing — this is
    // just narrowing, not a second auth check.
    if (request.user) {
      request.orgScope = createOrgScope(request.user.organizationId);
    }
    return true;
  }
}
