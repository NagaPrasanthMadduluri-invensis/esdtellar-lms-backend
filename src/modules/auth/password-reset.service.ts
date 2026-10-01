import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';

import { hashPassword } from '@/common/crypto/password.util';
import { EMAIL_CONSTANTS } from '@/config/configuration';
import { EmailOutboxService } from '@/modules/email/email-outbox.service';

import { PasswordResetRepository } from './password-reset.repository';

/**
 * Forgot password.
 *
 * This is the feature email actually unlocks. Until now a learner who
 * forgot their password had to ask an admin to set a new one and read it
 * out — which §10.3.1.11 records as the reason the temporary-password field
 * is unmasked in the first place.
 *
 * ## The three rules this flow turns on
 *
 * 1. **The request route never says whether the address exists.** One
 *    answer for every input, always 200, always the same sentence. §5.3
 *    already makes that rule for login — "or the form becomes an
 *    account-enumeration oracle" — and a reset form is the same oracle with
 *    a friendlier label. It is the easier one to get wrong, because "no
 *    account with that email" feels like helpful UX.
 *
 * 2. **The database stores a HASH, never the token.** Anyone who can read
 *    `password_reset_tokens` would otherwise hold a live takeover primitive
 *    for every row in it. Same reasoning as `users.password`, and the same
 *    shape: the token goes out in the email and is never persisted.
 *
 * 3. **A successful reset signs every session out.** Somebody resetting a
 *    password they believe was compromised, and finding the attacker still
 *    logged in, has gained nothing.
 */
const TOKEN_BYTES = 32;
const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX = 3;

/** The one sentence the request route ever returns. See rule 1. */
const NEUTRAL_RESPONSE = {
  message:
    'If that email address has an account, a reset link is on its way. ' +
    'Check your spam folder if it does not arrive within a few minutes.',
};

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly repository: PasswordResetRepository,
    private readonly email: EmailOutboxService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Always returns the same thing. Every branch below that looks like an
   * early exit is a case where we deliberately do nothing and say the same
   * sentence anyway.
   */
  async request(
    email: string,
    ip: string | null,
  ): Promise<{ message: string }> {
    try {
      const user = await this.repository.findActiveByEmail(email.trim());

      // No account, inactive account, or a suspended organization. Says the
      // same thing as success — see rule 1.
      if (!user) return NEUTRAL_RESPONSE;

      /**
       * Rate limited PER ACCOUNT, not per IP.
       *
       * The attack this stops is mailbox flooding: somebody pointing a
       * script at a known address to bury the real mail, or simply to
       * annoy. An IP limit would not stop it and would break a whole
       * office behind one NAT.
       *
       * Hitting the limit still returns the neutral sentence. Saying "too
       * many attempts" would confirm the address exists, which is the one
       * thing rule 1 is protecting.
       */
      const recent = await this.repository.recentCount(
        user.id,
        RATE_LIMIT_WINDOW_MINUTES,
      );
      if (recent >= RATE_LIMIT_MAX) {
        this.logger.warn(
          `Reset rate limit hit for user ${user.id} (${recent} in ` +
            `${RATE_LIMIT_WINDOW_MINUTES}m). Not sending.`,
        );
        return NEUTRAL_RESPONSE;
      }

      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      // A product decision, not a deployment one — nobody sets this
      // differently per environment.
      const ttl = EMAIL_CONSTANTS.passwordResetTtlMinutes;
      const expiresAt = new Date(Date.now() + ttl * 60_000);

      await this.repository.issue(user.id, hashToken(token), expiresAt, ip);

      const origin = (
        this.config.get<string>('clientOrigin') ?? 'http://localhost:3000'
      ).replace(/\/+$/, '');

      await this.email.enqueue({
        organizationId: user.organization_id,
        userIds: [user.id],
        type: 'password_reset',
        subject: 'Reset your Spectra LMS password',
        body:
          `Somebody asked to reset the password for ${user.email}. ` +
          `Use the button below within ${ttl} minutes. ` +
          'If it was not you, ignore this email — nothing has changed and ' +
          'your current password still works.',
        link: `/reset-password?token=${encodeURIComponent(token)}`,
      });

      this.logger.log(`Reset link issued for user ${user.id}.`);
    } catch (error) {
      /**
       * Even a failure says the neutral sentence. A 500 here would be
       * another oracle — "the error only happens for real accounts" is a
       * perfectly good enumeration signal.
       */
      this.logger.error(
        `Reset request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return NEUTRAL_RESPONSE;
  }

  /**
   * Whether a token is good, for the page to render before asking for a new
   * password.
   *
   * Worth a round trip: a learner who types a new password twice and only
   * then hears the link expired has to start over having wasted the effort.
   */
  async check(token: string): Promise<{ valid: boolean; reason?: string }> {
    const row = await this.repository.findByHash(hashToken(token));
    if (!row) return { valid: false, reason: 'not_found' };
    if (row.used_at) return { valid: false, reason: 'used' };
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: true };
  }

  async reset(
    token: string,
    newPassword: string,
  ): Promise<{ message: string }> {
    /**
     * The same four rules `changePassword` enforces, reported the same way.
     *
     * Checked BEFORE the token is consumed, so a password that fails the
     * rules does not burn the link and force another email.
     */
    assertStrong(newPassword);

    const row = await this.repository.findByHash(hashToken(token));

    // Three distinct answers rather than one "invalid link", because the
    // useful next step differs: ask again, ask again, or go and sign in.
    if (!row) {
      throw new UnprocessableEntityException(
        'This reset link is not valid. Request a new one.',
      );
    }
    if (row.used_at) {
      throw new UnprocessableEntityException(
        'This reset link has already been used. Request a new one if you ' +
          'still need to change your password.',
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new UnprocessableEntityException(
        'This reset link has expired. Request a new one.',
      );
    }

    /**
     * Consume first. If this returns false, another request consumed the
     * same token between the read above and here — rare, but the window is
     * real and the outcome of ignoring it is two concurrent resets racing
     * to set different passwords.
     */
    const consumed = await this.repository.consume(row.id);
    if (!consumed) {
      throw new UnprocessableEntityException(
        'This reset link has already been used. Request a new one.',
      );
    }

    await this.repository.setPassword(row.user_id, hashPassword(newPassword));

    /**
     * Tell them it happened, and do not wait for it.
     *
     * This is the email that matters if the reset was NOT them: it is the
     * only signal an account holder gets that somebody else has taken the
     * account. Which is also why it ignores the master opt-out
     * (`UNSUPPRESSABLE` in `email-types.ts`).
     */
    void this.email.enqueue({
      organizationId: row.organization_id,
      userIds: [row.user_id],
      type: 'password_changed',
      subject: 'Your Spectra LMS password was changed',
      body:
        'Your password was just changed using a reset link, and every ' +
        'signed-in session has been ended. If this was not you, contact ' +
        'your administrator immediately — somebody else has access to your ' +
        'email.',
      link: '/login',
    });

    return {
      message:
        'Your password has been changed. You can sign in with it now.',
    };
  }
}

/**
 * SHA-256, not scrypt, and that is deliberate rather than an oversight.
 *
 * `users.password` uses scrypt because a password is low-entropy and
 * guessable, so the hash has to be slow. This token is 32 random bytes —
 * 256 bits of entropy — and brute-forcing it is not a thing that can
 * happen whatever the hash costs. What matters here is that the lookup is
 * fast enough to be a single indexed query, which scrypt would prevent
 * (you cannot index a salted hash you have to recompute per row).
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Shared with `changePassword`'s rules, reported field by field. */
function assertStrong(password: string): void {
  const rules = {
    minLength: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
  if (Object.values(rules).every(Boolean)) return;
  throw new UnprocessableEntityException({
    message: 'New password does not meet strength requirements',
    errors: {
      minLength: rules.minLength ? null : 'Must be at least 8 characters',
      uppercase: rules.uppercase
        ? null
        : 'Must contain at least one uppercase letter',
      number: rules.number ? null : 'Must contain at least one number',
      special: rules.special
        ? null
        : 'Must contain at least one special character',
    },
  });
}
