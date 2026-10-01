import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  Mailer,
  type OutgoingMail,
  type SendResult,
} from './mailer.interface';

/**
 * The default driver: prints and returns success.
 *
 * It is the default rather than `ses` on purpose. A deployment that sets
 * `EMAIL_ENABLED=true` and forgets `EMAIL_DRIVER` writes to a log, which is
 * recoverable; the opposite mistake is not.
 *
 * The recipient and the full CTA URL are logged because the URL is the thing
 * that is most often wrong — `CLIENT_ORIGIN` left at localhost produces mail
 * that looks perfect and links nowhere, and this is where that gets caught
 * before an address is ever involved.
 */
@Injectable()
export class LogMailerService extends Mailer {
  readonly kind = 'log' as const;
  private readonly logger = new Logger('Mailer:log');

  unavailableReason(): string | null {
    return null;
  }

  send(mail: OutgoingMail): Promise<SendResult> {
    const link = /href="(https?:\/\/[^"]+)"/.exec(mail.html)?.[1];
    this.logger.log(
      `→ ${mail.to} :: ${mail.subject}${link ? ` :: ${link}` : ''}`,
    );
    return Promise.resolve({ messageId: `log-${randomUUID()}` });
  }
}
