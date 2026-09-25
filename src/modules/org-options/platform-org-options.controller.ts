import { Body, Controller, Get, Param, ParseIntPipe, Put, Query } from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import { SetJobLevelsDto, SetLocationsDto } from './dto/org-options.dto';
import { OrgOptionsService } from './org-options.service';

/**
 * Branch locations and job levels, from EDSTELLAR's side. Writes live only
 * here.
 *
 * A delegated route (§5.2.1): the organization is named in the path rather
 * than taken from the caller's token, which is safe only because
 * `@PlatformAdmin()` has already established the caller administers the
 * platform. Behind any weaker guard this would let one tenant rewrite
 * another's dropdowns.
 */
@Controller('platform/organizations/:organizationId/options')
@PlatformAdmin()
export class PlatformOrgOptionsController {
  constructor(private readonly options: OrgOptionsService) {}

  /** `?active=1` to hide retired entries; the console wants them all. */
  @Get()
  async get(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Query('active') active?: string,
  ) {
    return this.options.optionsFor(organizationId, active === '1');
  }

  @Put('locations')
  async setLocations(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Body() dto: SetLocationsDto,
  ) {
    return this.options.setLocations(organizationId, dto);
  }

  @Put('job-levels')
  async setJobLevels(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Body() dto: SetJobLevelsDto,
  ) {
    return this.options.setJobLevels(organizationId, dto);
  }
}
