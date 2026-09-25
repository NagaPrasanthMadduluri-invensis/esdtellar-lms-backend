import { Module } from '@nestjs/common';

import { AdminOrgOptionsController } from './admin-org-options.controller';
import { OrgOptionsRepository } from './org-options.repository';
import { OrgOptionsService } from './org-options.service';
import { PlatformOrgOptionsController } from './platform-org-options.controller';

/**
 * Dependency-free, so `UsersModule`, `AuthModule` and `OrganizationsModule`
 * can all import it to validate a location or seed a new tenant without a
 * cycle. Exports the SERVICE only (§3.2).
 */
@Module({
  controllers: [PlatformOrgOptionsController, AdminOrgOptionsController],
  providers: [OrgOptionsService, OrgOptionsRepository],
  exports: [OrgOptionsService],
})
export class OrgOptionsModule {}
