import { Module } from '@nestjs/common';

import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { EmailModule } from '@/modules/email/email.module';

import { EmailFailureAlertsService } from './email-failure-alerts.service';
import { RemindersRepository } from './reminders.repository';
import { RemindersService } from './reminders.service';

/**
 * Scheduled business reminders.
 *
 * No controller: nothing here is reachable over HTTP. It is driven entirely
 * by the worker's cron, which is also why it is imported by `WorkerModule`
 * and not by `AppModule` — the API has no reason to construct it.
 *
 * It goes through `NotificationsService`, never its own insert, so a
 * reminder lands in the bell and the inbox by the same path as everything
 * else. That is what makes `course_due_soon` obey the per-type email policy
 * and the learner's preferences without this module knowing either exists.
 */
@Module({
  imports: [NotificationsModule, EmailModule],
  providers: [RemindersRepository, RemindersService, EmailFailureAlertsService],
  exports: [RemindersService, EmailFailureAlertsService],
})
export class RemindersModule {}
