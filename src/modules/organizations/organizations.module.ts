import { Module } from '@nestjs/common';

import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';

/**
 * The platform-org provider. `PlatformAdminGuard` (global) depends on
 * `OrganizationsService`, which is why this module is imported by
 * `AppModule` even though it exposes no controller of its own yet — the org
 * CRUD surface (`modules/platform/`) arrives in a later wave.
 *
 * Exports the SERVICE only, never the repository (`BACKEND_STRUCTURE.md` §3.2).
 */
@Module({
  providers: [OrganizationsService, OrganizationsRepository],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
