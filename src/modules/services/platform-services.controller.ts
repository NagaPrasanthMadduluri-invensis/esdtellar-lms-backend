import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import { ServicesService } from './services.service';
import {
  ListPlatformRequestsDto,
  RespondToRequestDto,
} from './dto/service-request.dto';

/**
 * Edstellar's own queue: every tenant's service request, in one place.
 *
 * `@PlatformAdmin()` at the class level — `role === 'admin' AND
 * organizationId === platformOrgId` on every route, with no per-handler check
 * to forget (§5.2).
 *
 * This is the view §10.14 said must exist as its own guarded route rather than
 * by widening `/admin/services`. The split is the whole point: a tenant reads
 * and files its own requests; only Edstellar reads all of them, and only
 * Edstellar can move one past `pending`.
 */
@Controller('platform/service-requests')
@PlatformAdmin()
export class PlatformServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get()
  async list(@Query() query: ListPlatformRequestsDto) {
    return this.services.listForPlatform(query);
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.services.getForPlatform(id);
  }

  /** Move a request along and write the reply its admin will read. */
  @Patch(':id')
  async respond(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RespondToRequestDto,
  ) {
    return this.services.respond(id, dto);
  }
}
