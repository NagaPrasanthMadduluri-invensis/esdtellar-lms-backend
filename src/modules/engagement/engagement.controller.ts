import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import type { Granularity } from '@/modules/learning-hours/learning-hours.service';

import { EngagementService } from './engagement.service';
import {
  EngagementPingDto,
  EngagementTrendQueryDto,
} from './dto/engagement.dto';

/**
 * Engagement tracking + the engagement-vs-learning trend (spec: owner request
 * 2026-11-19). The ping is open to any authenticated role (every portal tracks
 * engagement); the trend reads are per audience.
 */
@Controller()
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  /** The client posts batches of active seconds here while the user is active. */
  @Post('engagement/ping')
  @HttpCode(200)
  async ping(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EngagementPingDto,
  ): Promise<{ ok: true }> {
    await this.engagement.ping(scope, user.userId, dto.seconds);
    return { ok: true };
  }

  /** The caller's own engagement-vs-learning trend. */
  @Get('learner/engagement/trend')
  @Roles('learner')
  learner(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EngagementTrendQueryDto,
  ) {
    return this.engagement.learnerTrend(
      scope,
      user.userId,
      (query.granularity as Granularity) ?? 'weekly',
    );
  }

  /** The organisation's engagement-vs-learning trend (reports audience). */
  @Get('admin/engagement/trend')
  @Roles('admin')
  @Permissions('view_reports')
  admin(
    @CurrentScope() scope: OrgScope,
    @Query() query: EngagementTrendQueryDto,
  ) {
    return this.engagement.orgTrend(
      scope,
      (query.granularity as Granularity) ?? 'weekly',
    );
  }
}
