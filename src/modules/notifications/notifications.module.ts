import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

/**
 * Dependency-free on purpose, exactly like `ActivityModule` (§10.12) and
 * `JourneyGateModule` (§10.11): every module that does something worth
 * telling somebody about imports this one, so it must depend on nothing or
 * those imports become cycles.
 *
 * Exports the SERVICE only (§3.2) — a module inserting straight into
 * `notifications` would bypass the never-throw contract that makes notifying
 * safe to call from a write path.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
  exports: [NotificationsService],
})
export class NotificationsModule {}
