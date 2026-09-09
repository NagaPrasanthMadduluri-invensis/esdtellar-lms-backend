import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Permission } from '@/common/permissions';

import { PERMISSIONS_KEY } from '../decorators';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Enforces `@Permissions()` — `specs/rbac.md` §4.1.
 *
 * Runs after `AuthGuard` (which has already rejected a token whose
 * `permVersion` is stale) and after `RolesGuard`. A route with no
 * `@Permissions()` is unaffected, so every existing endpoint keeps behaving
 * exactly as it did.
 *
 * The permissions come from the signed JWT, never from a lookup here: the
 * token is the only thing a request carries that the client cannot edit, and
 * re-reading them per request would put a query in front of every endpoint.
 * The freshness problem that creates is solved in `AuthGuard` instead, by
 * comparing the organization's `perm_version` — so a revoked permission takes
 * effect on the next request rather than in seven days.
 *
 * Requires ALL listed permissions. `@Permissions('a', 'b')` means a AND b;
 * there is deliberately no "any of" form, because every call site so far wants
 * conjunction and an OR would need to be read carefully at each one.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const held = new Set(user?.permissions ?? []);
    const missing = required.filter((permission) => !held.has(permission));

    if (missing.length > 0) {
      // Names the permission rather than saying "Forbidden": an admin
      // debugging their own role configuration needs to know which one, and
      // the caller is already authenticated, so nothing is disclosed that the
      // roles screen does not already show them.
      throw new ForbiddenException(
        `Missing permission: ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
