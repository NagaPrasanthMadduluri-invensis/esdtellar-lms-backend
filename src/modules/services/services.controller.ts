import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { ServicesService } from './services.service';
import {
  CreateServiceRequestDto,
  ListServiceRequestsDto,
} from './dto/service-request.dto';

/**
 * Edstellar Services — the org admin's half.
 *
 * The CATALOGUE is not served from here. It is code the browser already holds
 * (`client/lib/edstellar-services.js`), so an endpoint returning it would be a
 * round trip to fetch a constant. This module exists for the part that is
 * genuinely per-tenant: the requests an organization has filed.
 *
 * There is deliberately NO route here that moves a request past `pending`.
 * Only Edstellar does that, and Edstellar is a platform admin — a status write
 * on this controller would let a tenant mark its own request "Proposal sent".
 */
@Controller('admin/services')
@Roles('admin')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get('requests')
  @Permissions('request_services')
  async list(
    @CurrentScope() scope: OrgScope,
    @Query() query: ListServiceRequestsDto,
  ) {
    return this.services.list(scope, query.limit ?? 50, query.offset ?? 0);
  }

  @Get('requests/:id')
  @Permissions('request_services')
  async get(
    @CurrentScope() scope: OrgScope,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.services.get(scope, id);
  }

  @Post('requests')
  @Permissions('request_services')
  async create(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateServiceRequestDto,
  ) {
    return this.services.create(scope, user, dto);
  }
}
