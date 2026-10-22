import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { MyDataService } from './my-data.service';
import {
  ListDataRequestsDto,
  ResolveDataRequestDto,
} from './dto/data-request.dto';

/**
 * Data requests — the admin's queue (0056).
 *
 * Org-scoped: an admin sees and actions only their own tenant's requests
 * (§10.12). No new permission — the read reuses `view_employees` and the write
 * `manage_users`, so deploying this does not bump `perm_version` or sign an
 * organization out (§10.17). Actioning a correction/deletion is the same weight
 * as managing a user, which is what `manage_users` already governs.
 */
@Controller('admin/data-requests')
@Roles('admin')
export class AdminDataRequestsController {
  constructor(private readonly myData: MyDataService) {}

  @Get()
  @Permissions('view_employees')
  async list(
    @CurrentScope() scope: OrgScope,
    @Query() query: ListDataRequestsDto,
  ) {
    return this.myData.listRequests(scope, {
      status: query.status,
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
    });
  }

  @Patch(':id')
  @Permissions('manage_users')
  async resolve(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolveDataRequestDto,
  ) {
    return this.myData.resolveRequest(scope, id, user.userId, dto);
  }
}
