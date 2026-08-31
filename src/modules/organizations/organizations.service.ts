import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { OrganizationsRepository } from './organizations.repository';

/**
 * Resolves the platform organization's id ONCE at boot and holds it in
 * memory for the lifetime of the process. Every later phase depends on this
 * value — `@PlatformAdmin()`, the global course/SCORM catalogue, cross-org
 * analytics — so it is looked up here rather than hard-coded (it is `9` on
 * this database; a fresh install will get a different id).
 */
@Injectable()
export class OrganizationsService implements OnModuleInit {
  private readonly logger = new Logger(OrganizationsService.name);
  private platformOrganizationId: number | null = null;

  constructor(private readonly repository: OrganizationsRepository) {}

  async onModuleInit(): Promise<void> {
    const id = await this.repository.findPlatformOrganizationId();
    if (id === null) {
      // Every downstream phase assumes this exists (spec §3.2). Failing boot
      // loudly here is far cheaper than every org admin silently being able
      // to reach platform-only routes because the check never had anything
      // to compare against.
      throw new Error(
        'OrganizationsService: no organization has is_platform = true. ' +
          'Create the platform organization before starting the server.',
      );
    }

    this.platformOrganizationId = id;
    this.logger.log(`Platform organization resolved: id=${id}`);
  }

  /** The platform organization's id, resolved once at boot. Never a literal. */
  getPlatformOrganizationId(): number {
    if (this.platformOrganizationId === null) {
      throw new Error(
        'OrganizationsService: platform organization id read before onModuleInit ran',
      );
    }
    return this.platformOrganizationId;
  }
}
