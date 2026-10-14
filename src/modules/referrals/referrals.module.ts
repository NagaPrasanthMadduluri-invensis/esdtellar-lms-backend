import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { EmailModule } from '@/modules/email/email.module';

import { PlatformReferralsController } from './platform-referrals.controller';
import { ReferralsController } from './referrals.controller';
import { ReferralsRepository } from './referrals.repository';
import { ReferralsService } from './referrals.service';

/**
 * Referrals (§10.36). Imports `EmailModule` — unlike the Services module — because
 * the invite goes to a NON-USER address and must be enqueued directly through
 * `EmailOutboxService.enqueueDirect`, which the user-id-based `notify()` cannot
 * do. In-system notifications still go through `NotificationsModule`.
 */
@Module({
  imports: [ActivityModule, NotificationsModule, EmailModule],
  controllers: [ReferralsController, PlatformReferralsController],
  providers: [ReferralsService, ReferralsRepository],
})
export class ReferralsModule {}
