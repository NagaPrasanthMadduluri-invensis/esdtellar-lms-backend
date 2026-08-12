import { Module } from '@nestjs/common';

import {
  AdminSessionsController,
  LearnerSessionsController,
} from './sessions.controller';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';

@Module({
  controllers: [AdminSessionsController, LearnerSessionsController],
  providers: [SessionsService, SessionsRepository],
})
export class SessionsModule {}
