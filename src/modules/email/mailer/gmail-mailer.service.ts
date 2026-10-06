import { createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PRODUCT_NAME } from '../email-brand';
import { composeMime } from './mime';
import { Mailer, MailSendError, type OutgoingMail, type SendResult } from './mailer.interface';

/**
 * Sends through the Gmail API, as a real mailbox.
 *
 * ## Why not an SDK
 *
 * `googleapis` is tens of megabytes to do two HTTPS calls — fetch an access
 * token, POST a message. The same reasoning that put SESv2 over HTTPS rather
 * than SMTP applies here, and the MIME composition is already written
 * (`buildMime`) because `List-Unsubscribe` needed it.
 *
 * ## Two ways to authenticate, and they are not equivalent
 *
 * **Service account + domain-wide delegation** is the right answer for an
 * unattended server: no human, no expiry, and the token is minted from a key
 * this process holds. It needs a Workspace super-admin to authorise the
 * service account's client id for `gmail.send`.
 *
 * **A refresh token** works with an ordinary OAuth *web* client, which is
 * what most people have to hand. One caveat decides whether it is safe to
 * launch on: while the OAuth consent screen is in **Testing** publishing
 * status, Google expires refresh tokens after SEVEN DAYS. Mail then stops
 * dead a week after go-live, with a `invalid_grant` that looks like nothing
 * else changed. `scripts/gmail-authorize.mjs` mints the token and says this
 * in its output; `npm run email:verify` repeats it.
 *
 * Service account wins when both are configured, because it is the one that
 * cannot expire underneath you.
 *
 * ## Gmail is a SMALL pipe
 *
 * Workspace allows roughly 2,000 external recipients a day, a consumer
 * account 500 — against SES's 50,000. An announcement fans out to an
 * organization's whole active learner population, so a single one can spend
 * a day's quota. `EMAIL_MAX_PER_DAY` is what actually holds the line; the
 * verifier compares it against `GMAIL_DAILY_CEILING` and complains when the
 * outbox is configured to send more than Google will accept.
 */
@Injectable()
export class GmailMailerService extends Mailer {
  readonly kind = 'gmail' as const;

  private readonly logger = new Logger(GmailMailerService.name);

  /** Cached access token and the moment it stops being usable. */
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {
    super();
    if (this.config.get<string>('email.driver') === 'gmail') {
      const reason = this.unavailableReason();
      if (reason) this.logger.error(`Gmail sending is NOT configured — ${reason}`);
    }
  }

  /** Whichever credential is configured, or null when neither is. */
  private mode(): 'service-account' | 'refresh-token' | null {
    if (this.config.get<string>('email.gmail.serviceAccountKey')) {
      return 'service-account';
    }
    if (
      this.config.get<string>('email.gmail.clientId') &&
      this.config.get<string>('email.gmail.clientSecret') &&
      this.config.get<string>('email.gmail.refreshToken')
    ) {
      return 'refresh-token';
    }
    return null;
  }

  unavailableReason(): string | null {
    if (!this.config.get<string>('email.from')) {
      return 'EMAIL_FROM is not set.';
    }
    const mode = this.mode();
    if (mode === null) {
      const hasPair =
        this.config.get<string>('email.gmail.clientId') &&
        this.config.get<string>('email.gmail.clientSecret');
      return hasPair
        ? 'GMAIL_REFRESH_TOKEN is missing. A client id and secret alone cannot '
          + 'send — run `npm run email:gmail-authorize` to mint one, or set '
          + 'GMAIL_SERVICE_ACCOUNT_KEY instead.'
        : 'No Gmail credential. Set GMAIL_SERVICE_ACCOUNT_KEY (preferred), or '
          + 'GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN.';
    }
    if (mode === 'service-account' && !this.config.get<string>('email.gmail.impersonate')) {
      return 'GMAIL_IMPERSONATE is not set. A service account has no mailbox '
        + 'of its own — it has to send AS somebody.';
    }
    return null;
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    const reason = this.unavailableReason();
    if (reason) throw new MailSendError(reason, false);

    const from = this.config.get<string>('email.from') as string;
    const raw = await composeMime({
      mail,
      from,
      fromName: PRODUCT_NAME,
      messageId: randomUUID(),
    });

    /*
     * Gmail wants base64URL, not plain base64. Easy to miss, and the error
     * it produces ("Invalid value for ByteString") names nothing useful.
     */
    const encoded = raw
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const accessToken = await this.accessToken();
    const mailbox =
      this.config.get<string>('email.gmail.impersonate') || 'me';

    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailbox)}/messages/send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw: encoded }),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw this.classify(res.status, body);
    }

    const json = (await res.json()) as { id?: string };
    return { messageId: json.id ?? `gmail-${Date.now()}` };
  }

  /**
   * Turns Gmail's HTTP status into the three cases the drain loop needs.
   *
   * The distinction that matters is that 429 and 403-with-rateLimitExceeded
   * are NOT message failures — the message was never wrong, we were going
   * too fast — so they return the row to `pending` without consuming an
   * attempt. An `invalid_grant` is the opposite: no number of retries fixes
   * it, and it is overwhelmingly the seven-day Testing-mode expiry, so the
   * message says so rather than leaving somebody reading OAuth docs.
   */
  private classify(status: number, body: string): MailSendError {
    const lower = body.toLowerCase();

    if (status === 429 || lower.includes('ratelimitexceeded') || lower.includes('userratelimitexceeded')) {
      return new MailSendError(`Gmail rate limit: ${body.slice(0, 200)}`, true, true);
    }
    if (lower.includes('invalid_grant')) {
      return new MailSendError(
        'Gmail refused the credential (invalid_grant). If the OAuth consent '
        + 'screen is still in Testing, refresh tokens expire after 7 days — '
        + 'publish the app and re-run `npm run email:gmail-authorize`.',
        false,
        false,
        true,
      );
    }
    if (status === 401 || status === 403) {
      return new MailSendError(
        `Gmail rejected the request (${status}): ${body.slice(0, 200)}`,
        false,
        false,
        // Nothing queued will succeed until a human fixes the credential,
        // so the whole tick stops rather than burning every row's attempts.
        true,
      );
    }
    if (status >= 500) {
      return new MailSendError(`Gmail ${status}: ${body.slice(0, 200)}`, true);
    }
    return new MailSendError(`Gmail ${status}: ${body.slice(0, 200)}`, false);
  }

  /** A cached access token, refreshed a minute before it lapses. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const fetched =
      this.mode() === 'service-account'
        ? await this.tokenFromServiceAccount()
        : await this.tokenFromRefreshToken();

    this.token = {
      value: fetched.accessToken,
      expiresAt: Date.now() + fetched.expiresIn * 1000,
    };
    return fetched.accessToken;
  }

  private async tokenFromRefreshToken() {
    const body = new URLSearchParams({
      client_id: this.config.get<string>('email.gmail.clientId') as string,
      client_secret: this.config.get<string>('email.gmail.clientSecret') as string,
      refresh_token: this.config.get<string>('email.gmail.refreshToken') as string,
      grant_type: 'refresh_token',
    });
    return this.exchange(body);
  }

  /**
   * Signs a JWT and trades it for an access token.
   *
   * RS256 with `node:crypto` rather than a JWT library — it is one `sign`
   * call over two base64url segments, and the alternative is a dependency
   * for thirty lines.
   */
  private async tokenFromServiceAccount() {
    const key = this.serviceAccountKey();
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o))
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const header = b64({ alg: 'RS256', typ: 'JWT' });
    const claims = b64({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/gmail.send',
      aud: 'https://oauth2.googleapis.com/token',
      // The mailbox being impersonated. Without `sub` the token is the
      // service account's own, which has no Gmail mailbox at all.
      sub: this.config.get<string>('email.gmail.impersonate'),
      iat: now,
      exp: now + 3600,
    });

    const signature = createSign('RSA-SHA256')
      .update(`${header}.${claims}`)
      .sign(key.private_key)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return this.exchange(
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
    );
  }

  private serviceAccountKey(): { client_email: string; private_key: string } {
    const raw = this.config.get<string>('email.gmail.serviceAccountKey') as string;
    // A path or the JSON itself, because a key is awkward to put in an env
    // var on one line and awkward to put on disk in a container.
    const text = raw.trimStart().startsWith('{') ? raw : readFileSync(raw, 'utf8');
    const parsed = JSON.parse(text) as { client_email?: string; private_key?: string };
    if (!parsed.client_email || !parsed.private_key) {
      throw new MailSendError(
        'GMAIL_SERVICE_ACCOUNT_KEY is not a service-account key — it has no '
        + 'client_email/private_key. An OAuth *web* client JSON is a '
        + 'different thing and cannot be used here.',
        false,
      );
    }
    return { client_email: parsed.client_email, private_key: parsed.private_key };
  }

  private async exchange(body: URLSearchParams) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw this.classify(res.status, text);

    const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      throw new MailSendError(`Gmail token response had no access_token: ${text.slice(0, 200)}`, false);
    }
    return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
  }
}
