import { Module } from '@nestjs/common';

import { AlertsModule } from '@/modules/alerts/alerts.module';

import { HealthController } from './health.controller';

@Module({
  imports: [AlertsModule],
  controllers: [HealthController],
})
export class HealthModule {}
