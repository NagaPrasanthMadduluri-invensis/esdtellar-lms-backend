import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { FeedbackRepository } from './feedback.repository';
import { FeedbackService } from './feedback.service';
import { LearnerFeedbackController } from './learner-feedback.controller';
import { TrainerFeedbackController } from './trainer-feedback.controller';

/**
 * Session feedback. Two audiences, two controllers (§2.2): the learner writes
 * it, the trainer reads it without names.
 *
 * Exports the service so `BadgesModule` can count a learner's submissions for
 * `feedback_hero`, which reported 0 for everybody until this module existed.
 * The service, never the repository (§3.2) — the count has a business meaning
 * and the badge should not be able to reach past it into the table.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [LearnerFeedbackController, TrainerFeedbackController],
  providers: [FeedbackService, FeedbackRepository],
  exports: [FeedbackService],
})
export class FeedbackModule {}
