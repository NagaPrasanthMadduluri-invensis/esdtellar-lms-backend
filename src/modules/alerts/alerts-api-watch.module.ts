import { Module } from '@nestjs/common';

import { AlertsModule } from './alerts.module';
import { ApiWatchService } from './watchdog.service';

/** The API process's watcher of the worker heartbeat (§10.50). AppModule only. */
@Module({
  imports: [AlertsModule],
  providers: [ApiWatchService],
})
export class AlertsApiWatchModule {}
