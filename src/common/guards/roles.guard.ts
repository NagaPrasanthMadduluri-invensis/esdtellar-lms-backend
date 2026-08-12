import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '../decorators';
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

    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Forbidden');
    }
    return true;
  }
}
