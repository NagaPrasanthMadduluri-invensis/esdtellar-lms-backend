import { Controller, Get } from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { BadgesService } from './badges.service';

@Controller('learner/badges')
@Roles('learner')
export class LearnerBadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @CurrentScope() scope: OrgScope) {
    return this.badges.listForLearner(scope, user.userId);
  }
}
