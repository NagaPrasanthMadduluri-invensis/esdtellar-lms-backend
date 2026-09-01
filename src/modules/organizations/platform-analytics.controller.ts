import { Controller, Get } from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import { OrganizationsService } from './organizations.service';

/** Cross-org analytics — the one board a platform admin sees above every org. */
@Controller('platform/analytics')
@PlatformAdmin()
export class PlatformAnalyticsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  async get() {
    return this.organizations.getAnalytics();
  }
}
