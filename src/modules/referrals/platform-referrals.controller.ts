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

import { ReferralsService } from './referrals.service';
import {
  ListPlatformReferralsDto,
  RespondToReferralDto,
} from './dto/referral.dto';

/**
 * Edstellar's own queue: every tenant's referral, in one place.
 *
 * `@PlatformAdmin()` at the class level (§5.2). This is the view §10.36 said
 * must exist as its own guarded route rather than by widening `/admin/referrals`
 * — a tenant reads and files its own referrals; only Edstellar reads all of
 * them, and only Edstellar can move one past `invited` or mark it converted.
 */
@Controller('platform/referrals')
@PlatformAdmin()
export class PlatformReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get()
  async list(@Query() query: ListPlatformReferralsDto) {
    return this.referrals.listForPlatform(query);
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.referrals.getForPlatform(id);
  }

  /** Move a referral along, write the reply, and link a conversion. */
  @Patch(':id')
  async respond(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RespondToReferralDto,
  ) {
    return this.referrals.respond(id, dto);
  }
}
