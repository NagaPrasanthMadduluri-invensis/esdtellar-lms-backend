import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import { RateLimit } from '@/common/rate-limit/rate-limit';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { LearnerInsightsService } from './learner-insights.service';

/**
 * The learner's AI recommendations panel (spec ai-insights.md Wave 2).
 *
 * No `@Permissions()` — seeing your own suggestions is not a capability an
 * organization grants, and the subject is always the caller (identity from the
 * token, no id parameter). When the feature is off the GET returns
 * `{ enabled: false, insight: null }` and the panel renders a quiet off-state.
 */
@Controller('learner/ai')
@Roles('learner')
export class LearnerInsightsController {
  constructor(private readonly insights: LearnerInsightsService) {}

  @Get('insights')
  get(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.insights.getInsights(scope, user.userId);
  }

  /**
   * On-demand regeneration. Capped tight because each call spends model tokens:
   * five an hour per learner is plenty for a human pressing Refresh and stops a
   * scripted flood from running up a bill.
   */
  @Post('insights/refresh')
  @HttpCode(200)
  @RateLimit({
    name: 'ai-learner-refresh',
    by: 'user',
    limit: 5,
    windowSeconds: 3600,
    message: 'You have refreshed your insights a few times recently. Try again a little later.',
  })
  refresh(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.insights.refresh(scope, user.userId);
  }
}
