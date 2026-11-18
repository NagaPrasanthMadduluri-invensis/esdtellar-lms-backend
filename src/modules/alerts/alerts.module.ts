import { Module } from '@nestjs/common';

import { AlertsRepository } from './alerts.repository';
import { AlertsService } from './alerts.service';
import { WorkerWatchService } from './watchdog.service';

/**
 * Cliq alerts (§10.50). Dependency-free (DatabaseModule and ConfigModule are
 * global), so any module may import it without risking a cycle. The API-side
 * watcher is NOT here: it starts a timer, and this module is also loaded by
 * the worker. It lives in AlertsApiWatchModule, imported by AppModule only.
 */
@Module({
  providers: [AlertsService, AlertsRepository, WorkerWatchService],
  exports: [AlertsService, AlertsRepository, WorkerWatchService],
})
export class AlertsModule {}
