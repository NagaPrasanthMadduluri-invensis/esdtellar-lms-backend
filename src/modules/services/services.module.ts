import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { ActivityModule } from '@/modules/activity/activity.module';

import { PlatformServicesController } from './platform-services.controller';
import { ServicesController } from './services.controller';
import { ServicesRepository } from './services.repository';
import { ServicesService } from './services.service';

@Module({
  imports: [ActivityModule, NotificationsModule],
  controllers: [ServicesController, PlatformServicesController],
  providers: [ServicesService, ServicesRepository],
})
export class ServicesModule {}
