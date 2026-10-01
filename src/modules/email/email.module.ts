import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailController } from './email.controller';
import { EmailOutboxRepository } from './email-outbox.repository';
import { EmailOutboxService } from './email-outbox.service';
import { OutboxDrainJob } from './queue/outbox-drain.job';
import { PlatformEmailController } from './platform-email.controller';
import { SesEventsController } from './ses-events.controller';
import { EmailRenderService } from './email-render.service';
import { FileMailerService } from './mailer/file-mailer.service';
import { LogMailerService } from './mailer/log-mailer.service';
import { Mailer } from './mailer/mailer.interface';
import { SesMailerService } from './mailer/ses-mailer.service';

/**
 * The email module.
 *
 * ## It imports nothing, and that is load-bearing
 *
 * `NotificationsModule` is dependency-free precisely so that the eleven
 * modules with something worth announcing can all import it without a
 * cycle. It now imports THIS one, so the same property has to hold here or
 * that carefully-kept arrangement collapses. `ConfigModule` and
 * `DatabaseModule` are both global, so neither needs importing.
 *
 * It is deliberately NOT `@Global()`. `DatabaseModule`'s own docblock claims
 * to be the only global feature module in the codebase, and that claim is
 * worth keeping true.
 *
 * ## It exports the service, never the repository
 *
 * §3.2. A module inserting straight into `email_outbox` would walk past the
 * gate — the policy check, the preferences, the suppression list, the
 * allowlist and the fan-out ceiling all live in the service. The repository
 * would happily write a row to somebody who has unsubscribed.
 *
 * `OutboxDrainJob` is exported because the worker schedules it, and it
 * lives HERE rather than in the worker module for exactly that reason: it
 * needs the repository, and keeping it inside is what lets the repository
 * stay private.
 */
@Module({
  controllers: [EmailController, SesEventsController, PlatformEmailController],
  providers: [
    EmailOutboxRepository,
    EmailOutboxService,
    EmailRenderService,
    OutboxDrainJob,
    LogMailerService,
    FileMailerService,
    SesMailerService,
    {
      /**
       * The driver is chosen once, at boot, from `EMAIL_DRIVER`.
       *
       * All three are instantiated so that an unknown value falls back to
       * `log` rather than leaving the token unprovided — a typo in the env
       * should make the API send nothing, not fail to start.
       */
      provide: Mailer,
      inject: [ConfigService, LogMailerService, FileMailerService, SesMailerService],
      useFactory: (
        config: ConfigService,
        log: LogMailerService,
        file: FileMailerService,
        ses: SesMailerService,
      ): Mailer => {
        switch (config.get<string>('email.driver')) {
          case 'ses':
            return ses;
          case 'file':
            return file;
          default:
            return log;
        }
      },
    },
  ],
  exports: [EmailOutboxService, OutboxDrainJob],
})
export class EmailModule {}
