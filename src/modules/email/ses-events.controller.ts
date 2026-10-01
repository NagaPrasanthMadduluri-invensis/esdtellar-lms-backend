import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
} from '@nestjs/common';
import { createVerify } from 'node:crypto';

import { Public } from '@/common/decorators';

import { EmailOutboxRepository } from './email-outbox.repository';

/**
 * SES bounce and complaint events, delivered by SNS.
 *
 * ## The signature check is the whole security model here
 *
 * This endpoint is `@Public()` — SNS cannot authenticate — and it WRITES TO
 * THE SUPPRESSION LIST. Unverified, it is a denial-of-service primitive:
 * anyone who finds the URL could suppress any address they like, including
 * every admin's, and the product would quietly stop emailing them with
 * nothing on any screen to explain it.
 *
 * So every message is verified against Amazon's published certificate
 * before its body is read. A message that does not verify is dropped and
 * logged; it is never parsed for content.
 *
 * ## Why bother at all when SES already suppresses
 *
 * The configuration set's account-level suppression stops SES delivering to
 * a bounced address, which protects the reputation. It does not tell US
 * anything — our rows would sit `sent` forever and an admin asking "did
 * this learner get it" would be told yes. This is how we know.
 */

const AMAZON_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/i;
const CERT_CACHE = new Map<string, string>();

interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  Token?: string;
  SubscribeURL?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
}

@Controller('email')
export class SesEventsController {
  private readonly logger = new Logger('SesEvents');

  constructor(private readonly repository: EmailOutboxRepository) {}

  @Public()
  @Post('ses-events')
  @HttpCode(200)
  async handle(@Body() body: SnsEnvelope) {
    if (!(await this.verify(body))) {
      this.logger.warn('Dropped an SNS message that failed verification.');
      // 200 regardless. A 4xx tells an attacker which messages verify, and
      // makes SNS retry a message we will never accept.
      return { ok: true };
    }

    if (body.Type === 'SubscriptionConfirmation') {
      // Deliberately NOT auto-confirmed. Confirming subscribes this endpoint
      // to whatever topic asked, and the signature only proves Amazon sent
      // it — not that WE created the topic. Confirm from the AWS console.
      this.logger.warn(
        `SNS subscription confirmation received for ${body.TopicArn}. ` +
          'Confirm it from the AWS console — this endpoint will not ' +
          'subscribe itself.',
      );
      return { ok: true };
    }

    if (body.Type !== 'Notification' || !body.Message) return { ok: true };

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(body.Message) as Record<string, unknown>;
    } catch {
      return { ok: true };
    }

    await this.record(event);
    return { ok: true };
  }

  private async record(event: Record<string, unknown>): Promise<void> {
    const type = String(event.eventType ?? event.notificationType ?? '');
    const mail = event.mail as { messageId?: string } | undefined;
    const messageId = mail?.messageId ?? null;

    if (type === 'Bounce') {
      const bounce = event.bounce as
        | { bounceType?: string; bouncedRecipients?: Array<{ emailAddress?: string }> }
        | undefined;

      /**
       * Transient is a full mailbox or an out-of-office bounce. Suppressing
       * on one would permanently stop emailing somebody who was simply on
       * holiday, which is a far worse outcome than a few wasted sends.
       */
      if (bounce?.bounceType !== 'Permanent') {
        this.logger.log(`Transient bounce for ${messageId ?? 'unknown'} — logged only.`);
        return;
      }

      for (const r of bounce.bouncedRecipients ?? []) {
        if (!r.emailAddress) continue;
        await this.repository.suppress(
          r.emailAddress,
          'hard_bounce',
          messageId,
        );
        this.logger.warn(`Suppressed ${r.emailAddress} — permanent bounce.`);
      }
      return;
    }

    if (type === 'Complaint') {
      const complaint = event.complaint as
        | { complainedRecipients?: Array<{ emailAddress?: string }> }
        | undefined;

      for (const r of complaint?.complainedRecipients ?? []) {
        if (!r.emailAddress) continue;
        await this.repository.suppress(r.emailAddress, 'complaint', messageId);

        /**
         * A complaint is an unsubscribe expressed angrily, so it is honoured
         * as one as well as suppressed. The suppression protects the domain;
         * the preference is what makes it survive somebody later being
         * removed from the suppression list by hand.
         */
        if (messageId) {
          const userId = await this.repository.userIdForMessage(messageId);
          if (userId) await this.repository.savePreferences(userId, 1, '');
        }
        this.logger.warn(`Suppressed ${r.emailAddress} — complaint.`);
      }
    }
  }

  /**
   * Verifies the message really came from Amazon.
   *
   * The canonical string is the documented field order per message type —
   * it is not a hash of the JSON, and the order is not alphabetical by
   * accident: it is the order AWS specifies, and getting it wrong rejects
   * every legitimate message.
   */
  private async verify(body: SnsEnvelope): Promise<boolean> {
    const { Signature, SigningCertURL, SignatureVersion, Type } = body;
    if (!Signature || !SigningCertURL || !Type) return false;

    // SignatureVersion 1 is SHA1, 2 is SHA256. Anything else is not ours.
    if (SignatureVersion !== '1' && SignatureVersion !== '2') return false;

    let host: string;
    try {
      const url = new URL(SigningCertURL);
      host = url.hostname;
      // The certificate URL is attacker-controlled input. Without this check
      // we would fetch and trust a certificate from any host they name,
      // which makes the whole signature meaningless.
      if (url.protocol !== 'https:' || !AMAZON_CERT_HOST.test(host)) {
        return false;
      }
    } catch {
      return false;
    }

    const pem = await this.certificate(SigningCertURL);
    if (!pem) return false;

    const fields =
      Type === 'Notification'
        ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
        : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

    const canonical = fields
      .filter((f) => body[f as keyof SnsEnvelope] !== undefined)
      .map((f) => `${f}\n${String(body[f as keyof SnsEnvelope])}\n`)
      .join('');

    try {
      const verifier = createVerify(
        SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256',
      );
      verifier.update(canonical, 'utf8');
      return verifier.verify(pem, Signature, 'base64');
    } catch {
      return false;
    }
  }

  private async certificate(url: string): Promise<string | null> {
    const cached = CERT_CACHE.get(url);
    if (cached) return cached;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const pem = await response.text();
      // Bounded, so a flood of distinct URLs cannot grow this without limit.
      if (CERT_CACHE.size > 10) CERT_CACHE.clear();
      CERT_CACHE.set(url, pem);
      return pem;
    } catch {
      return null;
    }
  }
}
