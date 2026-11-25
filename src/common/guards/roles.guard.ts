import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY, ROLES_KEY } from '../decorators';
import type {
  AuthenticatedRequest,
  UserRole,
} from '../types/authenticated-request';

/**
 * Runs after AuthGuard. A route with no @Roles() is open to any authenticated
 * user; @Roles('admin') restricts it to admins.
 *
 * The role comes from the signed JWT, never from a request body or a separate
 * cookie — that is the fix for the legacy middleware, which read the role out
 * of an unsigned `lms_user` cookie that any client could edit.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const { user } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    if (!user) throw new ForbiddenException('Forbidden');
    if (required.includes(user.role)) return true;

    /*
     * EXTRA PERMISSIONS CROSS PORTALS (§10.65). A Learner, Manager or Trainer
     * role can be given admin permissions in the matrix, and the grant has to
     * mean something: such a caller may use an admin route, but ONLY one that
     * names a permission (`@Permissions()` or `@CrossPortal()`).
     * `PermissionsGuard` runs next and decides whether they hold it. An admin
     * route naming no permission (MFA, the admin's own settings) stays closed
     * to every other portal, exactly as before. Never the reverse direction:
     * learner and trainer routes stay their own portal's.
     */
    if (required.includes('admin') && user.role !== 'admin') {
      const targets = [context.getHandler(), context.getClass()];
      const named =
        (this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets)?.length ?? 0) > 0 ||
        (this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, targets)?.length ?? 0) > 0;
      if (named && (user.permissions?.length ?? 0) > 0) return true;
    }
    throw new ForbiddenException('Forbidden');
  }
}
