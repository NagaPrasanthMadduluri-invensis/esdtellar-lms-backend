import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { Permission } from '@/common/permissions';

import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY, ROLES_KEY } from '../decorators';
import type { UserRole } from '../types/authenticated-request';
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
 * Requires ALL listed permissions. `@Permissions('a', 'b')` means a AND b.
 * The one "any of" form is `@CrossPortal()`, and it binds only callers from
 * outside the route's portal (see its docblock and §10.65).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      targets,
    );
    const anyOf = this.reflector.getAllAndOverride<Permission[]>(
      ANY_PERMISSIONS_KEY,
      targets,
    );
    if ((!required || required.length === 0) && (!anyOf || anyOf.length === 0)) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const held = new Set(user?.permissions ?? []);

    if (required && required.length > 0) {
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
    }

    // `@CrossPortal()` (shared admin reads): binds only a caller from another
    // portal, who needs one of the listed. The route's own audience is
    // unaffected, which is what keeps content reads open to every admin role.
    const audience = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, targets);
    const ownAudience = !audience || audience.length === 0 || (!!user && audience.includes(user.role));
    if (anyOf && anyOf.length > 0 && !ownAudience && !anyOf.some((p) => held.has(p))) {
      throw new ForbiddenException(
        `Missing permission: one of ${anyOf.join(', ')}`,
      );
    }
    return true;
  }
}
