import { Module } from '@nestjs/common';

import { LeaderboardModule } from '@/modules/leaderboard/leaderboard.module';
import { LearningHoursModule } from '@/modules/learning-hours/learning-hours.module';

import { BadgesModule } from '@/modules/badges/badges.module';
import { CertificatesModule } from '@/modules/certificates/certificates.module';

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
  imports: [LeaderboardModule, LearningHoursModule, CertificatesModule, BadgesModule, JourneysModule],
  controllers: [LearnerController],
  providers: [LearnerService, LearnerRepository],
})
export class LearnerModule {}
