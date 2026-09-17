import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { SeatsService } from './seats.service';
import { SeatRequestDto } from './dto/seats.dto';

/**
 * The TENANT's side of seats: how many they have, how many are used, and
 * asking for more.
 *
 * No route here writes `seat_limit` — only the platform does that. A tenant
 * raising its own cap would make the limit meaningless.
 */
@Controller('admin/seats')
@Roles('admin')
export class SeatsController {
  constructor(private readonly seats: SeatsService) {}

  /** Used, limit, remaining — what Manage Users shows above the table. */
  @Get()
  @Permissions('view_employees')
  async usage(@CurrentScope() scope: OrgScope) {
    return this.seats.usage(scope);
  }

  @Get('requests')
  @Permissions('view_employees')
  async list(@CurrentScope() scope: OrgScope) {
    return this.seats.listForOrg(scope);
  }

  /**
   * Ask for more seats.
   *
   * `manage_users` rather than `view_employees`: this is a commercial ask on
   * the organization's behalf, and the role that can only look at the employee
   * list should not be able to make it.
   */
  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_users')
  async request(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SeatRequestDto,
  ) {
    return this.seats.request(scope, user, dto);
  }
}
