import { Module } from '@nestjs/common';

import { RetentionRepository } from './retention.repository';
import { RetentionService } from './retention.service';

/**
 * Data-retention sweep. No controller — driven by the worker's cron only, so
 * it is imported by WorkerModule and not AppModule (the API never runs it).
 * DatabaseModule is @Global, so the repository needs no explicit import.
 */
@Module({
  providers: [RetentionRepository, RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
