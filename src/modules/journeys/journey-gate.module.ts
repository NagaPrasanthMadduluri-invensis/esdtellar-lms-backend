import { Module } from '@nestjs/common';

import { JourneyGateService } from './journey-gate.service';

/**
 * The journey lock, on its own, with no dependencies but the database.
 *
 * Separate from `JourneysModule` so that every module delivering course
 * content can import it — including the ones `JourneysModule` itself depends
 * on. Importing the full journeys module in those places would be a cycle.
 */
@Module({
  providers: [JourneyGateService],
  exports: [JourneyGateService],
})
export class JourneyGateModule {}
