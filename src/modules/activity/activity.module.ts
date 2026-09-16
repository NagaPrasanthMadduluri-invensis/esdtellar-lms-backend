import { Module } from '@nestjs/common';

import { ActivityRepository } from './activity.repository';
import { ActivityService } from './activity.service';

/**
 * Dependency-free on purpose, like `JourneyGateService` (§10.11): every module
 * that does something worth recording imports this one, so it must be able to
 * depend on nothing. Exports the service only (§3.2) — a module writing
 * straight into `activity_log` would bypass the never-throw contract that
 * makes recording safe to call from a write path.
 */
@Module({
  providers: [ActivityService, ActivityRepository],
  exports: [ActivityService],
})
export class ActivityModule {}
