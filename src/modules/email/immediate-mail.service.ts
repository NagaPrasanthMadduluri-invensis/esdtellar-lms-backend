import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailOutboxRepository, type OutboxRow } from './email-outbox.repository';
import { EmailRenderService } from './email-render.service';
import { Mailer } from './mailer/mailer.interface';

/**
 * Sends one email NOW, from the calling process, bypassing the outbox queue.
 *
 * Exactly one use: two-step sign-in codes (0069). The outbox is right for
 * everything else (durable, retried, paced), but a person waiting at the
 * sign-in screen cannot wait for the next drain tick, and a code must never
 * be written to `email_outbox`, whose bodies are kept for 90 days. So: the
 * same address gates as the outbox (email switched on, suppression list,
 * EMAIL_ALLOWLIST), the same renderer and mailer, and no row.
 *
 * It THROWS when the mail cannot be sent (unlike `enqueue`): the caller has a
 * person on screen who must be told to use a recovery code instead.
 */
@Injectable()
export class ImmediateMailService {
  private readonly logger = new Logger(ImmediateMailService.name);

  constructor(
    private readonly repository: EmailOutboxRepository,
    private readonly renderer: EmailRenderService,
    @Inject(Mailer) private readonly mailer: Mailer,
    private readonly config: ConfigService,
  ) {}

  /** Whether emailed codes can work at all on this server. */
  get available(): boolean {
    return this.config.get<boolean>('email.enabled') ?? false;
  }

  async sendSignInCode(input: {
    userId: number;
    organizationId: number;
    toEmail: string;
    toName: string | null;
    orgName: string | null;
    code: string;
    minutes: number;
    /** 'enrol' while switching two-step sign-in on; 'login' at sign-in. */
    purpose?: 'enrol' | 'login';
  }): Promise<void> {
    if (!this.available) {
      throw new ServiceUnavailableException('Email codes are not available on this server.');
    }
    const email = input.toEmail.trim().toLowerCase();
    if (await this.repository.isSuppressed(email)) {
      throw new ServiceUnavailableException('Email cannot be delivered to this address. Use a recovery code.');
    }
    const allowlist = this.config.get<string[]>('email.allowlist') ?? [];
    if (allowlist.length && !allowlist.some((e) => (e.startsWith('@') ? email.endsWith(e) : email === e))) {
      throw new ServiceUnavailableException('Email to this address is held by EMAIL_ALLOWLIST on this server.');
    }
    const row: OutboxRow = {
      id: 0,
      organizationId: input.organizationId,
      userId: input.userId,
      type: 'mfa_code',
      policy: 'transactional',
      toEmail: email,
      toName: input.toName,
      orgName: input.orgName,
      orgLogoUrl: null,
      facts: JSON.stringify([{ label: 'Your code', value: input.code }]),
      subjectName: null,
      subject: 'Your Spectra LMS sign-in code',
      body:
        input.purpose === 'enrol'
          ? `Enter this code to finish setting up email codes for two-step sign-in. It expires in ${input.minutes} minutes and works once.\n\nIf you did not ask for this, someone may be signed in to your account: change your password now and tell your administrator.`
          : `Enter this code to finish signing in. It expires in ${input.minutes} minutes and works once.\n\nIf you did not try to sign in, someone may have your password: change it now and tell your administrator.`,
      link: null,
      actorName: null,
      attempts: 0,
    };
    try {
      await this.mailer.send(this.renderer.render(row));
    } catch (error) {
      this.logger.error(`Sign-in code email for user ${input.userId} failed: ${String(error)}`);
      throw new ServiceUnavailableException('The code email could not be sent. Try again, or use a recovery code.');
    }
    this.logger.log(`Sign-in code emailed to user ${input.userId}.`);
  }
}
