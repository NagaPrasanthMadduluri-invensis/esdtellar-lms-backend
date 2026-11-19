import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import { RateLimit } from '@/common/rate-limit/rate-limit';
import type { OrgScope } from '@/database/org-scope';

import { AdminInsightsService } from './admin-insights.service';

/**
 * The admin's AI org briefing (spec ai-insights.md Wave 3).
 *
 * Guarded by `view_reports` — this is organisation analytics, the same evidence
 * that permission already gates (§10.32). No new permission, so deploying it
 * does not bump `perm_version`. The org is always the caller's own
 * (`@CurrentScope`); there is no id parameter to point elsewhere.
 */
@Controller('admin/ai')
@Roles('admin')
export class AdminInsightsController {
  constructor(private readonly insights: AdminInsightsService) {}

  @Get('insights')
  @Permissions('view_reports')
  get(@CurrentScope() scope: OrgScope) {
    return this.insights.getInsights(scope);
  }

  /** The real-data Learning Intelligence payload (risk radar, course
   *  effectiveness, skill intelligence, inactivity, departments). */
  @Get('intelligence')
  @Permissions('view_reports')
  intelligence(@CurrentScope() scope: OrgScope) {
    return this.insights.intelligence(scope);
  }

  @Post('insights/refresh')
  @HttpCode(200)
  @Permissions('view_reports')
  @RateLimit({
    name: 'ai-admin-refresh',
    by: 'user',
    limit: 5,
    windowSeconds: 3600,
    message: 'You have refreshed the briefing a few times recently. Try again a little later.',
  })
  refresh(@CurrentScope() scope: OrgScope) {
    return this.insights.refresh(scope);
  }
}
