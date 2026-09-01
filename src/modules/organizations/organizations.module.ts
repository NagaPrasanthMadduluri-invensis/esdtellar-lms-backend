import { Module } from '@nestjs/common';

import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';
import { PlatformAnalyticsController } from './platform-analytics.controller';
import { PlatformAnalyticsRepository } from './platform-analytics.repository';
import { PlatformOrganizationsController } from './platform-organizations.controller';

/**
 * The platform-org provider AND the super-admin org CRUD / cross-org
 * analytics surface (spec phase 6 — `modules/platform/` was folded into this
 * existing module rather than duplicated, per the task brief). This module is
 * imported by `AppModule` unconditionally because `PlatformAdminGuard`
 * (global) depends on `OrganizationsService` regardless of whether any
 * platform route is ever hit.
 *
 * Exports the SERVICE only, never either repository
 * (`BACKEND_STRUCTURE.md` §3.2). `PlatformAnalyticsRepository` in particular
 * must never be reachable from another module — every cross-org read goes
 * through `OrganizationsService`, which is the one place `@PlatformAdmin()`
 * is guaranteed to have already run.
 */
@Module({
  controllers: [PlatformOrganizationsController, PlatformAnalyticsController],
  providers: [
    OrganizationsService,
    OrganizationsRepository,
    PlatformAnalyticsRepository,
  ],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
