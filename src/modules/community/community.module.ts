import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { AdminCommunityController } from './admin-community.controller';
import { CommunityRepository } from './community.repository';
import { CommunityService } from './community.service';
import { LearnerCommunityController } from './learner-community.controller';

/**
 * Learning Community (0049): a per-organization space for questions,
 * achievements and discussions, with replies and likes. Imports
 * `NotificationsModule` to tell a post's author about new replies.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [LearnerCommunityController, AdminCommunityController],
  providers: [CommunityService, CommunityRepository],
})
export class CommunityModule {}
