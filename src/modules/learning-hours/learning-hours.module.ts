import { Module } from '@nestjs/common';

import { LearningHoursRepository } from './learning-hours.repository';
import { LearningHoursService } from './learning-hours.service';

/**
 * Exports the service only. Both the learner and reports modules depend on it
 * for hours, and neither may reach the repository directly (3.2) — that is what
 * keeps a single definition of what an hour of learning is.
 */
@Module({
  providers: [LearningHoursService, LearningHoursRepository],
  exports: [LearningHoursService],
})
export class LearningHoursModule {}
