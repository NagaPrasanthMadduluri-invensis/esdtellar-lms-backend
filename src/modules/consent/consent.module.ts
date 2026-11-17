import { Module } from '@nestjs/common';

import { ConsentLogRepository } from './consent-log.repository';
import { ConsentLogService } from './consent-log.service';

/**
 * The consent log (0065). DEPENDENCY-FREE, like ActivityModule and
 * NotificationsModule, because Auth, Email and MyData all write to it, and
 * EmailModule in particular must import nothing that could become a cycle.
 * Exports the service only (§3.2).
 */
@Module({
  providers: [ConsentLogService, ConsentLogRepository],
  exports: [ConsentLogService],
})
export class ConsentModule {}
