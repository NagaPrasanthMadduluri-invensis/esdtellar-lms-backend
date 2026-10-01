import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { PRODUCT_NAME } from '../email-brand';
import { composeMime } from './mime';
import {
  Mailer,
  MailSendError,
  type OutgoingMail,
  type SendResult,
} from './mailer.interface';

/**
 * Amazon SES, over the SESv2 HTTPS API.
 *
 * ## Why the API and not SMTP on 587
 *
 * Both reach SES and port 587 is open from the box, so this is a real
 * choice. Three reasons the API wins here:
 *
 *   1. **No credential on disk.** The box is EC2 in ap-south-1, so the SDK
 *      takes an IAM instance role and this module has no credential
 *      variable at all. An SMTP user and password sitting in `server/.env`
 *      is strictly worse, and §9 already says no secret is committed — not
 *      having one to commit is better still.
 *   2. **`SendEmail` returns the MessageId synchronously.** That id is the
 *      ONLY key that correlates an asynchronous SNS bounce or complaint back
 *      to the row that caused it. Over SMTP the id arrives in a 250 response
 *      string that has to be parsed.
 *   3. **Typed exceptions.** The drain loop has to tell throttling from
 *      rejection from an account-level pause, and act differently on each.
 *      SMTP gives a numeric code and a sentence.
 *
 * ## Degrading rather than failing to boot
 *
 * `unavailableReason()` mirrors `R2StorageService`: missing configuration is
 * collected and reported, never thrown at construction. Email is not a hard
 * dependency of the API, and making it one would mean a missing `EMAIL_FROM`
 * takes the whole product down.
 */
@Injectable()
export class SesMailerService extends Mailer {
  readonly kind = 'ses' as const;
  private readonly logger = new Logger('Mailer:ses');
  private client: SESv2Client | null = null;

  private readonly from: string;
  private readonly region: string;
  private readonly configurationSet: string;
  private readonly missing: string[] = [];

  constructor(private readonly config: ConfigService) {
    super();
    this.from = this.config.get<string>('email.from') ?? '';
    this.region = this.config.get<string>('email.ses.region') ?? '';
    this.configurationSet =
      this.config.get<string>('email.ses.configurationSet') ?? '';

    if (!this.from) this.missing.push('EMAIL_FROM');
    if (!this.region) this.missing.push('SES_REGION');

    // Same conditional as below: the sentence says "SES driver selected",
    // and saying it while the `file` driver is active would be a lie.
    if (
      this.missing.length > 0 &&
      this.config.get<string>('email.driver') === 'ses'
    ) {
      this.logger.warn(
        `SES driver selected but ${this.missing.join(', ')} ${
          this.missing.length === 1 ? 'is' : 'are'
        } not set. Email will not be sent. Set ${
          this.missing.length === 1 ? 'it' : 'them'
        } in server/.env and RESTART — these are read at boot.`,
      );
    }
    if (this.missing.length > 0) return;

    /**
     * No `credentials` key at all, deliberately.
     *
     * The SDK's default provider chain resolves AWS_ACCESS_KEY_ID /
     * AWS_SECRET_ACCESS_KEY, then the shared config file, then the EC2
     * instance role — which is what production uses and what keeps any
     * SES credential off this box's disk entirely. Passing an object with
     * empty strings would NOT fall through; it would configure an empty
     * credential and fail at send.
     */
    this.client = new SESv2Client({ region: this.region });

    // Only when SES is the SELECTED driver. All three mailers are
    // instantiated so an unknown EMAIL_DRIVER can fall back to `log`, so an
    // unconditional warning here tells a `file`-driver developer their SES
    // is misconfigured — which is true and entirely irrelevant.
    if (!this.configurationSet && this.config.get<string>('email.driver') === 'ses') {
      this.logger.warn(
        'SES_CONFIGURATION_SET is not set. Account-level bounce and ' +
          'complaint suppression will not apply to these sends, which is ' +
          'the cheapest protection there is for a sending reputation.',
      );
    }
  }

  unavailableReason(): string | null {
    if (this.missing.length > 0) {
      return `SES is not configured: ${this.missing.join(', ')} missing.`;
    }
    return this.client ? null : 'SES client could not be constructed.';
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    if (!this.client) {
      throw new MailSendError(
        this.unavailableReason() ?? 'SES unavailable',
        false,
      );
    }

    const raw = await composeMime({
      mail,
      from: this.from,
      fromName: PRODUCT_NAME,
      messageId: randomUUID(),
    });

    try {
      const out = await this.client.send(
        new SendEmailCommand({
          Content: { Raw: { Data: raw } },
          Destination: { ToAddresses: [mail.to] },
          FromEmailAddress: `${PRODUCT_NAME} <${this.from}>`,
          ...(this.configurationSet
            ? { ConfigurationSetName: this.configurationSet }
            : {}),
        }),
      );
      return { messageId: out.MessageId ?? `ses-${randomUUID()}` };
    } catch (error) {
      throw classify(error);
    }
  }
}

/**
 * Maps an SES failure onto what the drain loop should DO about it.
 *
 * The distinction that matters most is the middle one: throttling is not a
 * message failure. The message was fine; we were going too fast. Counting it
 * as an attempt would burn a row's five tries on our own pacing and
 * eventually mark a perfectly good email `failed`.
 */
function classify(error: unknown): MailSendError {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  const message = error instanceof Error ? error.message : String(error);

  // The account is in trouble. Stop the whole tick — continuing to hammer
  // SES while it is telling us to stop is how a pause becomes a closure.
  if (name === 'AccountSendingPausedException' || name === 'SendingPausedException') {
    return new MailSendError(
      `SES sending is paused for this account: ${message}`,
      false,
      false,
      true,
    );
  }

  if (name === 'ThrottlingException' || name === 'TooManyRequestsException') {
    return new MailSendError(message, true, true);
  }

  // Unverified recipient (the sandbox default), or a malformed address.
  // Retrying changes nothing until a human acts.
  if (name === 'MessageRejected' || name === 'BadRequestException') {
    return new MailSendError(message, false);
  }

  if (
    name === 'MailFromDomainNotVerifiedException' ||
    name === 'NotFoundException'
  ) {
    return new MailSendError(`Configuration problem: ${message}`, false);
  }

  // Network, 5xx, timeouts — genuinely worth another go.
  return new MailSendError(message, true);
}
