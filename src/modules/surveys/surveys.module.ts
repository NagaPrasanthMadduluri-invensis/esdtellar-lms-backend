import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { AdminSurveysController } from './admin-surveys.controller';
import {
  LearnerSurveyListController,
  LearnerSurveysController,
} from './learner-surveys.controller';
import { SurveysRepository } from './surveys.repository';
import { SurveysService } from './surveys.service';

/**
 * Course feedback: editable templates and the answers learners give (0034).
 *
 * Separate from `FeedbackModule`, which owns SESSION feedback, because the
 * two ask different questions of different people and show them to different
 * audiences — a trainer never sees a name, an admin always does. One module
 * holding both would be one service whose every method had to say which half
 * it belonged to.
 *
 * Exports the service so `CoursesModule` can read a course's resolved
 * template when it saves one. The service, never the repository (§3.2).
 */
@Module({
  imports: [NotificationsModule],
  controllers: [
    AdminSurveysController,
    LearnerSurveysController,
    LearnerSurveyListController,
  ],
  providers: [SurveysService, SurveysRepository],
  exports: [SurveysService],
})
export class SurveysModule {}
