import { Module } from '@nestjs/common';
import { AlertsModule } from '@/modules/alerts/alerts.module';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { IncidentsRepository } from './incidents.repository';
import { IncidentsService } from './incidents.service';
import { PlatformIncidentsController } from './platform-incidents.controller';

/**
 * The security incident register (0066). Imports only the dependency-free
 * NotificationsModule (to notify affected clients) and is imported by nothing.
 * A new notification type, so a deploy needs a worker restart.
 */
@Module({
  imports: [NotificationsModule, AlertsModule],
  controllers: [PlatformIncidentsController],
  providers: [IncidentsService, IncidentsRepository],
})
export class IncidentsModule {}
