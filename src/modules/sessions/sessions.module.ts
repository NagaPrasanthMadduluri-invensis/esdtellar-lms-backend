import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';

import { MediaModule } from '@/modules/media/media.module';

import {
  AdminSessionsController,
  LearnerSessionsController,
} from './sessions.controller';
import { TrainerSessionsController } from './trainer-sessions.controller';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';

@Module({
  // MediaService validates a thumbnail before it is stored on the training
  // course, and deletes the file when it is replaced or the session goes.
  imports: [ActivityModule, MediaModule],
  controllers: [
    AdminSessionsController,
    LearnerSessionsController,
    // One controller per audience (BACKEND_STRUCTURE.md §2.2). The trainer is
    // a third audience for the same capability, not a third module.
    TrainerSessionsController,
  ],
  providers: [SessionsService, SessionsRepository],
})
export class SessionsModule {}
