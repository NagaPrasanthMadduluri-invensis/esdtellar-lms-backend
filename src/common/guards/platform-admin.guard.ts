import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { OrganizationsService } from '@/modules/organizations/organizations.service';

import { PLATFORM_ADMIN_KEY } from '../decorators';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Runs after AuthGuard/RolesGuard. A route with no `@PlatformAdmin()` is
 * unaffected; one carrying it additionally requires the caller to be an
 * admin whose `organizationId` is the platform organization's — resolved
 * once at boot by `OrganizationsService`, never a hard-coded id.
 *
 * Because an org admin can only create users within their own `OrgScope`,
 * no org admin can ever mint a platform admin (spec §4.2).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly organizations: OrganizationsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      PLATFORM_ADMIN_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const { user } = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    const isPlatformAdmin =
      !!user &&
      user.role === 'admin' &&
      user.organizationId === this.organizations.getPlatformOrganizationId();

    if (!isPlatformAdmin) {
      throw new ForbiddenException('Forbidden');
    }
    return true;
  }
}
