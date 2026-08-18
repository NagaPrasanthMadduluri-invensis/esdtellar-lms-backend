import { Module } from '@nestjs/common';

import { LeaderboardRepository } from './leaderboard.repository';
import { LeaderboardService } from './leaderboard.service';

/** Service only — one ranking, read by the learner and admin boards alike. */
@Module({
  providers: [LeaderboardService, LeaderboardRepository],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
