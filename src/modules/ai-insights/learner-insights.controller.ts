import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import { RateLimit } from '@/common/rate-limit/rate-limit';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import {
  LearnerInsightsService,
  isLearnerLens,
  type LearnerLens,
} from './learner-insights.service';

/** Validate the lens path param against the registry (never raw input downstream). */
function parseLens(lens: string): LearnerLens {
  if (!isLearnerLens(lens)) {
    throw new BadRequestException(`Unknown AI lens: ${lens}`);
  }
  return lens;
}

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
   * Real-data charts for the AI Insights page (skills, competencies, course
   * status, categories, badges, points). Independent of whether the AI model is
   * enabled — these are the learner's own figures, reused from the canonical
   * services, not model output, so the page can show them whatever the feature
   * flag. Cheap read, no model tokens, so no tight rate limit.
   */
  @Get('charts')
  charts(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.insights.buildCharts(scope, user.userId);
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

  /**
   * A deeper lens (course_recommendations | skill_plan) — the learner's MULTIPLE
   * AI options beyond the coach. Read is cheap (stored insight); generation is
   * behind the refresh route below.
   */
  @Get('lens/:lens')
  getLens(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('lens') lens: string,
  ) {
    return this.insights.getLens(scope, user.userId, parseLens(lens));
  }

  @Post('lens/:lens/refresh')
  @HttpCode(200)
  @RateLimit({
    name: 'ai-learner-lens',
    by: 'user',
    limit: 5,
    windowSeconds: 3600,
    message: 'You have generated AI insights a few times recently. Try again a little later.',
  })
  refreshLens(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('lens') lens: string,
  ) {
    return this.insights.refreshLens(scope, user.userId, parseLens(lens));
  }
}
