import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { ListLearnerJourneysQueryDto } from './dto/journey.dto';
import { JourneysService } from './journeys.service';

/**
 * `GET /api/learner/badges` is deliberately NOT here — it belongs to the
 * agent building the badges/reward side (spec §5).
 */
@Controller('learner/journeys')
@Roles('learner')
export class LearnerJourneysController {
  constructor(private readonly journeys: JourneysService) {}

  @Get()
  async list(
    @Query() query: ListLearnerJourneysQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.journeys.listForLearner(scope, user.userId, {
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get(':id')
  async get(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.journeys.getForLearner(scope, user.userId, id);
  }
}
