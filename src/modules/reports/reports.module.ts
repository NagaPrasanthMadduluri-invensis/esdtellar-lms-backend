import { Module } from '@nestjs/common';

import { LeaderboardModule } from '@/modules/leaderboard/leaderboard.module';
import { LearningHoursModule } from '@/modules/learning-hours/learning-hours.module';

import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { ReportsController } from './reports.controller';
import { SpreadsheetService } from './spreadsheet.service';

/**
 * SpreadsheetService is exported because the users module reuses it for the
 * bulk-upload template download.
 */
@Module({
  imports: [LearningHoursModule, LeaderboardModule],
  controllers: [ReportsController],
  providers: [AnalyticsService, AnalyticsRepository, SpreadsheetService],
  exports: [SpreadsheetService],
})
export class ReportsModule {}
