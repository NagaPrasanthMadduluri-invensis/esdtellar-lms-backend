import { Module } from '@nestjs/common';

import { LeaderboardModule } from '@/modules/leaderboard/leaderboard.module';

import { BadgesRepository } from './badges.repository';
import { BadgesService } from './badges.service';
import { LearnerBadgesController } from './learner-badges.controller';

/**
 * BadgesService is exported so the lesson/assessment/SCORM completion
 * triggers and the journeys module (per-journey + milestone badges, spec
 * §4.2) can award and sync without querying `user_badges` themselves.
 */
@Module({
  imports: [LeaderboardModule],
  controllers: [LearnerBadgesController],
  providers: [BadgesService, BadgesRepository],
  exports: [BadgesService],
})
export class BadgesModule {}
