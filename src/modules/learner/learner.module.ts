import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { ReportsModule } from '@/modules/reports/reports.module';

import { LeaderboardModule } from '@/modules/leaderboard/leaderboard.module';
import { LearningHoursModule } from '@/modules/learning-hours/learning-hours.module';

import { BadgesModule } from '@/modules/badges/badges.module';
import { CertificatesModule } from '@/modules/certificates/certificates.module';
import { CompetenciesModule } from '@/modules/competencies/competencies.module';

import { LearnerController } from './learner.controller';
import { LearnerRepository } from './learner.repository';
import { LearnerService } from './learner.service';
import { JourneysModule } from '@/modules/journeys/journeys.module';

/**
 * Imports CertificatesModule so completing a lesson can auto-issue, and
 * BadgesModule so it can sync the nine catalogue badges on the same trigger
 * and on `GET /learner/achievements` (spec §4.5).
 */
@Module({
  imports: [NotificationsModule, ReportsModule, LeaderboardModule, LearningHoursModule, CertificatesModule, CompetenciesModule, BadgesModule, JourneysModule],
  controllers: [LearnerController],
  providers: [LearnerService, LearnerRepository],
  // Exported so the AI Insights vertical can reuse the ONE definition of a
  // learner's course progress/status/due/reward (§10.54) instead of writing a
  // second one. Nothing else injects it.
  exports: [LearnerService],
})
export class LearnerModule {}
