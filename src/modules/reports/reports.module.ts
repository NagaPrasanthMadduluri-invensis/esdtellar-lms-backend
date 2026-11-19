import { Module } from '@nestjs/common';

import { OrgOptionsModule } from '@/modules/org-options/org-options.module';

import { ActivityModule } from '@/modules/activity/activity.module';
import { LeaderboardModule } from '@/modules/leaderboard/leaderboard.module';
import { LearningHoursModule } from '@/modules/learning-hours/learning-hours.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { InsightsRepository } from './insights.repository';
import { InsightsService } from './insights.service';
import { ReportsController } from './reports.controller';
import { SpreadsheetService } from './spreadsheet.service';

/**
 * SpreadsheetService is exported because the users module reuses it for the
 * bulk-upload template download.
 */
@Module({
  imports: [ActivityModule, LearningHoursModule, LeaderboardModule, OrgOptionsModule, NotificationsModule],
  controllers: [ReportsController],
  providers: [
    AnalyticsService,
    AnalyticsRepository,
    InsightsService,
    InsightsRepository,
    SpreadsheetService,
  ],
  // AnalyticsService is exported so the AI Insights admin vertical can reuse the
  // ONE org aggregate (completion rate, dept roll-up, overdue) rather than
  // writing a second one (§10.54). Nothing else outside this module injects it.
  exports: [SpreadsheetService, AnalyticsService],
})
export class ReportsModule {}
