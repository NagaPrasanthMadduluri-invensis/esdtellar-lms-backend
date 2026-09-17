import { Module } from '@nestjs/common';

import { PlatformSeatsController } from './platform-seats.controller';
import { SeatsController } from './seats.controller';
import { SeatsRepository } from './seats.repository';
import { SeatsService } from './seats.service';

/**
 * Exports the SERVICE (§3.2) so `UsersModule` can call
 * `assertSeatAvailable()` before creating or reactivating a learner — the
 * enforcement that makes the limit real rather than decorative.
 */
@Module({
  controllers: [SeatsController, PlatformSeatsController],
  providers: [SeatsService, SeatsRepository],
  exports: [SeatsService],
})
export class SeatsModule {}
