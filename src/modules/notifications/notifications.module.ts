import { Module } from '@nestjs/common';

import { EmailModule } from '@/modules/email/email.module';

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
 *
 * `EmailModule` is the ONE import, and it is safe because that module
 * imports nothing itself (0037). It is what gives `notify()` a second
 * channel without any of the 25 call sites changing: a caller still asks
 * for a notification, and whether that also reaches an inbox is decided by
 * the type's policy in the catalogue, not at the call site.
 */
@Module({
  imports: [EmailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
  exports: [NotificationsService],
})
export class NotificationsModule {}
