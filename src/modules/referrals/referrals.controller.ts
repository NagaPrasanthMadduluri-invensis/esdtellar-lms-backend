import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { ReferralsService } from './referrals.service';
import { CreateReferralDto, ListReferralsDto } from './dto/referral.dto';

/**
 * Referrals — the org admin's half.
 *
 * An admin refers another company to become a Spectra customer, and earns a
 * tiered discount once a referral converts. There is deliberately NO route here
 * that moves a referral past `invited` or marks it converted: only Edstellar
 * does that (a platform admin), or a tenant could earn itself a discount for
 * nothing. Status writes live on the platform controller.
 */
@Controller('admin/referrals')
@Roles('admin')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get()
  @Permissions('manage_referrals')
  async list(
    @CurrentScope() scope: OrgScope,
    @Query() query: ListReferralsDto,
  ) {
    return this.referrals.list(scope, query.limit ?? 50, query.offset ?? 0);
  }

  @Get(':id')
  @Permissions('manage_referrals')
  async get(
    @CurrentScope() scope: OrgScope,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.referrals.get(scope, id);
  }

  @Post()
  @Permissions('manage_referrals')
  async create(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReferralDto,
  ) {
    return this.referrals.create(scope, user, dto);
  }
}
