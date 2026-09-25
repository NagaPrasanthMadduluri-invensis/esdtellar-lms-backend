import { Module } from '@nestjs/common';

import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

/** Reference data only — no database, no dependencies. */
@Module({
  controllers: [GeoController],
  providers: [GeoService],
  exports: [GeoService],
})
export class GeoModule {}
