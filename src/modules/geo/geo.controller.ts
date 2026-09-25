import { Controller, Get, Param } from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';
import { INDUSTRIES } from '@/common/industries';

import { GeoService } from './geo.service';

/**
 * Reference data for the tenant-onboarding form. PLATFORM ONLY.
 *
 * `@PlatformAdmin()` not because a country list is a secret, but because this
 * is the only screen that consumes it: a route open to everybody is a route
 * somebody will call from a tenant page, and then the city database is on the
 * hot path of a portal it has no business being in. Opening it later is one
 * decorator; narrowing it after something depends on it is not.
 */
@Controller('platform/geo')
@PlatformAdmin()
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** The industry list — a code catalogue, unlike branch locations. */
  @Get('industries')
  industries() {
    return { industries: [...INDUSTRIES] };
  }

  @Get('countries')
  countries() {
    return this.geo.countries();
  }

  @Get('countries/:code/cities')
  cities(@Param('code') code: string) {
    return this.geo.cities(code);
  }
}
