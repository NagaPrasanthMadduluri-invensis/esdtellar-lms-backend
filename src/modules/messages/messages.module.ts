import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { LearnerMessagesController } from './learner-messages.controller';
import { MessagesRepository } from './messages.repository';
import { MessagesService } from './messages.service';

/**
 * Direct messages (0054): two-way, per-person conversations within one org.
 * The dashboard "Say hi" opens one. Imports `NotificationsModule` to ping the
 * recipient's bell when a message arrives.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [LearnerMessagesController],
  providers: [MessagesService, MessagesRepository],
})
export class MessagesModule {}
