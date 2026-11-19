import { Module } from '@nestjs/common';

import { AiModule } from '@/modules/ai/ai.module';
import { BadgesModule } from '@/modules/badges/badges.module';
import { CompetenciesModule } from '@/modules/competencies/competencies.module';
import { LeaderboardModule } from '@/modules/leaderboard/leaderboard.module';
import { LearnerModule } from '@/modules/learner/learner.module';
import { ReportsModule } from '@/modules/reports/reports.module';
import { SurveysModule } from '@/modules/surveys/surveys.module';

import { AdminInsightsController } from './admin-insights.controller';
import { AdminInsightsRepository } from './admin-insights.repository';
import { AdminInsightsService } from './admin-insights.service';
import { LearnerInsightsController } from './learner-insights.controller';
import { LearnerInsightsRepository } from './learner-insights.repository';
import { LearnerInsightsService } from './learner-insights.service';

/**
 * The AI Insights verticals (spec ai-insights.md). Wave 2 ships the learner
 * side, Wave 3 the admin side.
 *
 * It imports `AiModule` for the OpenRouter engine and the canonical learner and
 * reports services so each feature context reuses their definitions rather than
 * writing second ones (§10.54). Exported so the worker can pre-generate on a
 * schedule (the nightly cron, a planned follow-up).
 */
@Module({
  imports: [
    AiModule,
    LearnerModule,
    LeaderboardModule,
    BadgesModule,
    CompetenciesModule,
    SurveysModule,
    ReportsModule,
  ],
  controllers: [LearnerInsightsController, AdminInsightsController],
  providers: [
    LearnerInsightsService,
    LearnerInsightsRepository,
    AdminInsightsService,
    AdminInsightsRepository,
  ],
  exports: [LearnerInsightsService, AdminInsightsService],
})
export class AiInsightsModule {}
