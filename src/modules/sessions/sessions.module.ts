import { Module } from '@nestjs/common';

import {
  AdminSessionsController,
  LearnerSessionsController,
} from './sessions.controller';
import { TrainerSessionsController } from './trainer-sessions.controller';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';

@Module({
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
