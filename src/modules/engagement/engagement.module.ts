import { Module } from '@nestjs/common';

import { LearningHoursModule } from '@/modules/learning-hours/learning-hours.module';

import { EngagementController } from './engagement.controller';
import { EngagementRepository } from './engagement.repository';
import { EngagementService } from './engagement.service';

/**
 * Engagement-hours tracking and its comparison with learning hours (2026-11-19).
 * Imports `LearningHoursModule` to REUSE the §10.4 learning-hours series for the
 * comparison rather than writing a second definition.
 */
@Module({
  imports: [LearningHoursModule],
  controllers: [EngagementController],
  providers: [EngagementService, EngagementRepository],
  exports: [EngagementService],
})
export class EngagementModule {}
