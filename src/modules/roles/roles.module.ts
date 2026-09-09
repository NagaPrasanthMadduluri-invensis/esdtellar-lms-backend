import { Module } from '@nestjs/common';

import { OrganizationsModule } from '@/modules/organizations/organizations.module';

import { AdminRolesController } from './admin-roles.controller';
import { PlatformRolesController } from './platform-roles.controller';
import { PlatformRolesService } from './platform-roles.service';
import { RolesRepository } from './roles.repository';
import { RolesService } from './roles.service';

/**
 * Imports `OrganizationsModule` for `OrganizationsService.scopeFor()`, which
 * is what lets a platform admin administer another organization's roles
 * (`specs/rbac.md` §3.9). The edge only goes this way — `OrganizationsModule`
 * does not import this one — so there is no cycle to break.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [AdminRolesController, PlatformRolesController],
  providers: [RolesService, RolesRepository, PlatformRolesService],
  exports: [RolesService],
})
export class RolesModule {}
