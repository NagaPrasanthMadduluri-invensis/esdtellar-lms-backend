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

/**
 * How long a WELCOME link lives: seven days.
 *
 * Much longer than a reset's 60 minutes, and for a different situation —
 * see `sendWelcome`. Somebody onboarded on a Friday should still be able
 * to use it on Monday.
 */
const WELCOME_TTL_MINUTES = 7 * 24 * 60;

/**
 * How many welcome emails go in one enqueue call.
 *
 * Under `EMAIL_MAX_RECIPIENTS_PER_NOTIFY` (200), which would otherwise
 * SKIP the whole batch and log — see `sendWelcomeMany` for why chunking
 * is the right answer here rather than raising that ceiling.
 */
const WELCOME_CHUNK = 100;

/**
 * The reconcile sweep ignores flags younger than this, so it never races a
 * request whose own enqueue is seconds from clearing the flag. Comfortably
 * longer than a bulk import takes to finish its batched enqueue.
 */
const WELCOME_RECONCILE_GRACE_MINUTES = 10;

/** Per sweep tick, so a huge backlog drains over several ticks rather than
 * one giant transaction. */
const WELCOME_RECONCILE_LIMIT = 500;
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
   * Welcomes a newly-created learner and lets them choose their own
   * password, instead of being sent one.
   *
   * ## Why a link and not the temporary password
   *
   * The outbox IS the message store and it keeps every body for 90 days
   * (0037). Emailing the password would therefore put a plaintext
   * credential in a database table readable by anyone with database
   * access, and leave it in the learner's inbox indefinitely — a wider
   * exposure than the admin screen, which merely shows it on a page while
   * somebody reads it out.
   *
   * A link stores only a SHA-256 hash, expires, and is spent on first use.
   * The temporary password still exists and still works, so an admin can
   * read it to somebody over the phone exactly as before. This only
   * changes what travels by email.
   *
   * ## A longer TTL than a reset, deliberately
   *
   * A reset link is 60 minutes because somebody asked for it 30 seconds
   * ago and is watching their inbox. A welcome is sent when an admin
   * onboards a batch, and the learner may not look until tomorrow — an
   * hour would make the link dead on arrival for most of them, and a dead
   * link is worse than no link because it reads as a broken product on
   * first contact.
   *
   * ## Best-effort, like every other notification (§8.4)
   *
   * Never throws. Creating the account is the thing the admin asked for;
   * an email failure must not fail it or leave a half-made user. The
   * account works regardless — the admin has the temporary password on
   * screen.
   */
  async sendWelcome(user: {
    id: number;
    email: string;
    organizationId: number;
    firstName?: string | null;
  }): Promise<void> {
    try {
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = new Date(
        Date.now() + WELCOME_TTL_MINUTES * 60_000,
      );
      await this.repository.issue(user.id, hashToken(token), expiresAt, null);

      await this.email.enqueue({
        organizationId: user.organizationId,
        userIds: [user.id],
        type: 'welcome',
        subject: 'Your Spectra LMS account is ready',
        subjectName: null,
        body:
          `${user.firstName ? `${user.firstName}, your` : 'Your'} account has `
          + 'been created. Choose a password below and you can start learning '
          + 'straight away.',
        facts: [
          { label: 'Sign in with', value: user.email },
          {
            label: 'This link lasts',
            value: `${Math.round(WELCOME_TTL_MINUTES / 60 / 24)} days — after that, use "Forgot password" on the sign-in page`,
          },
        ],
        link: `/reset-password?token=${encodeURIComponent(token)}`,
      });

      this.logger.log(`Welcome link issued for user ${user.id}.`);
    } catch (error) {
      this.logger.warn(
        `Welcome email not sent for user ${user.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Welcome MANY people at once, for the bulk import.
   *
   * ## Why not just call `sendWelcome` in a loop
   *
   * That is two round trips per person — a token insert and an enqueue —
   * so a 500-row import would be 1,000 of them inside one HTTP request,
   * on the path that is already the slowest in the product because it runs
   * `scryptSync` per row. This is a fixed handful regardless of size:
   * `issueMany` is two statements, and each enqueue chunk is one recipient
   * lookup plus one multi-row INSERT.
   *
   * ## Pacing is the WORKER's job, and that is the whole point
   *
   * Nothing here sends anything. It writes outbox rows, and the drain job
   * releases them at `EMAIL_RATE_PER_SECOND` in batches of
   * `EMAIL_BATCH_SIZE`, stopping at `EMAIL_MAX_PER_DAY`. So a 300-learner
   * import returns as fast as a 3-learner one, and the mail leaves over
   * the following minutes rather than in a burst that would trip Gmail's
   * own limit — which is the failure mode the ceiling below cannot see.
   *
   * ## The chunking is not evading the fan-out ceiling
   *
   * `EMAIL_MAX_RECIPIENTS_PER_NOTIFY` (200) exists to stop ONE event
   * reaching an unexpected crowd — an announcement fanning out to a whole
   * tenant. These are not that: each row is an individually addressed
   * message carrying its own one-time link, and the admin asked for
   * exactly this many by uploading exactly this many rows. Chunking under
   * the ceiling keeps that guard meaningful for the case it was written
   * for instead of raising it for everybody.
   *
   * Best-effort throughout (§8.4). The accounts exist and work regardless;
   * an email failure must not fail an import the admin already watched
   * succeed, and the Email Delivery page (§10.32) is where a failure is
   * visible afterwards.
   */
  async sendWelcomeMany(
    users: {
      id: number;
      email: string;
      organizationId: number;
      firstName?: string | null;
    }[],
  ): Promise<number> {
    if (users.length === 0) return 0;

    try {
      const expiresAt = new Date(Date.now() + WELCOME_TTL_MINUTES * 60_000);

      /* One token per person, minted here so the hash is all the database
       * ever sees — the plaintext exists only long enough to go in a link. */
      const linkByUserId = new Map<number, string>();
      const rows = users.map((user) => {
        const token = randomBytes(TOKEN_BYTES).toString('base64url');
        linkByUserId.set(
          user.id,
          `/reset-password?token=${encodeURIComponent(token)}`,
        );
        return { userId: user.id, tokenHash: hashToken(token), expiresAt };
      });

      await this.repository.issueMany(rows);

      const organizationId = users[0].organizationId;
      const days = Math.round(WELCOME_TTL_MINUTES / 60 / 24);
      let queued = 0;

      for (let i = 0; i < users.length; i += WELCOME_CHUNK) {
        const chunk = users.slice(i, i + WELCOME_CHUNK);
        queued += await this.email.enqueue({
          organizationId,
          userIds: chunk.map((u) => u.id),
          type: 'welcome',
          subject: 'Your Spectra LMS account is ready',
          subjectName: null,
          /*
           * No first name, unlike the single-user version. One body is
           * shared by the whole chunk, so personalising it would greet
           * every learner in the batch by the first one's name — worse
           * than not greeting them at all. The link IS per person; that is
           * what `linkByUserId` exists for.
           */
          body:
            'Your account has been created. Choose a password below and you '
            + 'can start learning straight away.',
          facts: [
            {
              label: 'This link lasts',
              value: `${days} days — after that, use "Forgot password" on the sign-in page`,
            },
          ],
          linkByUserId,
        });
      }

      /*
       * Clear the "owed a welcome" marker for everyone we just queued, so the
       * reconcile sweep (§10.33) does not pick them up again. The flag was set
       * atomically with the learner (0044); clearing it here makes the happy
       * path transient — set in the request, cleared in the same request — and
       * leaves the flag standing ONLY for learners whose enqueue never
       * happened, which is exactly what the sweep exists to catch.
       */
      if (queued > 0) {
        await this.repository.clearWelcomePending(users.map((u) => u.id));
      }

      this.logger.log(
        `Welcome links issued for ${users.length} imported user(s); ${queued} queued.`,
      );
      return queued;
    } catch (error) {
      this.logger.warn(
        `Bulk welcome emails not sent (${users.length} user(s)): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  /**
   * Re-enqueue the welcome for any learner whose flag is still set — the
   * safety net that makes "no bulk-created learner slips through" true rather
   * than almost-true.
   *
   * ## Why this is needed at all
   *
   * `bulkCreate` commits learners per row and enqueues their welcomes in a
   * batch afterwards (§7.1). That enqueue is best-effort: a restart in the
   * window, or a failed chunk write, leaves a learner created with no welcome
   * row and no retry — and Resend only recovers a FAILED row, not a MISSING
   * one. The outbox pattern guarantees delivery only once the row EXISTS; this
   * is what guarantees the row comes to exist.
   *
   * ## How it stays correct
   *
   * The flag (0044) is the durable intent, written atomically with the
   * learner. This runs on the worker clock (§10.33) and:
   *
   *   - reads learners whose flag is OLDER than a grace window, so it never
   *     races a request whose own enqueue is about to clear it;
   *   - asks the outbox which of them ALREADY have a welcome row — those had a
   *     successful enqueue whose flag-clear was lost, so it just clears the
   *     flag rather than sending a second welcome (idempotency);
   *   - sends the rest through the SAME `sendWelcomeMany` the request uses, so
   *     there is one credential path, not two, and it clears their flags on
   *     success.
   *
   * Best-effort as a whole (§8.4): it is a background reconciliation, and a
   * failure this tick is simply retried the next.
   */
  async reconcileWelcomes(): Promise<{
    checked: number;
    enqueued: number;
    alreadyHad: number;
  }> {
    try {
      const candidates = await this.repository.findPendingWelcomes(
        WELCOME_RECONCILE_GRACE_MINUTES,
        WELCOME_RECONCILE_LIMIT,
      );
      if (candidates.length === 0) return { checked: 0, enqueued: 0, alreadyHad: 0 };

      const have = await this.email.usersWithWelcome(candidates.map((c) => c.id));

      const alreadyHad = candidates.filter((c) => have.has(c.id));
      const toSend = candidates.filter((c) => !have.has(c.id));

      // Row existed, flag lingered — clear it, do not re-send.
      if (alreadyHad.length > 0) {
        await this.repository.clearWelcomePending(alreadyHad.map((c) => c.id));
      }

      // Never queued — send now. sendWelcomeMany clears their flags on success.
      const enqueued = toSend.length > 0 ? await this.sendWelcomeMany(toSend) : 0;

      if (toSend.length > 0 || alreadyHad.length > 0) {
        this.logger.warn(
          `Welcome reconcile: ${candidates.length} pending, ${enqueued} re-queued, `
          + `${alreadyHad.length} already had a row.`,
        );
      }
      return { checked: candidates.length, enqueued, alreadyHad: alreadyHad.length };
    } catch (error) {
      this.logger.warn(
        `Welcome reconcile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { checked: 0, enqueued: 0, alreadyHad: 0 };
    }
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

    await this.repository.setPassword(
      row.user_id,
      await hashPassword(newPassword),
    );

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
