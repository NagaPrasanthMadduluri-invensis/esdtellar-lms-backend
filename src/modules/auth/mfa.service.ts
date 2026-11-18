import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';

import {
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
} from '@/common/crypto/secret-box.util';
import type { RecoveryCode } from '@/database/schema';
import { ImmediateMailService } from '@/modules/email/immediate-mail.service';

import { MfaRepository } from './mfa.repository';

const ISSUER = 'Spectra LMS';
const RECOVERY_CODE_COUNT = 10;

export const MFA_METHODS = ['totp', 'email'] as const;
export type MfaMethod = (typeof MFA_METHODS)[number];

/** An emailed code lives 10 minutes, allows 5 wrong tries, and 5 can be sent per 15 minutes. */
const EMAIL_CODE_MINUTES = 10;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
const EMAIL_CODES_PER_WINDOW = 5;
const EMAIL_CODE_WINDOW_MINUTES = 15;

/**
 * Two-step sign-in (0058, methods 0069). Each person chooses:
 *
 *   totp   an authenticator app; the secret is encrypted at rest with
 *          MFA_ENCRYPTION_KEY
 *   email  a 6-digit code emailed at each sign-in, sent IMMEDIATELY (not
 *          queued) and stored only as a keyed hash
 *
 * Mandatory for admins, optional for everyone else (§10.49, §10.51).
 *
 * Setup is two steps for both methods. `setup` records a PENDING method (and
 * for email, sends a code); `enable` checks a first code and only then makes it
 * the ACTIVE method, with fresh recovery codes. Because pending and active are
 * separate columns, switching method never removes the protection someone
 * already has until the new method is confirmed.
 *
 * Recovery codes work at every sign-in whatever the method.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly key: string;
  private readonly pepper: string;

  constructor(
    private readonly repository: MfaRepository,
    private readonly mail: ImmediateMailService,
    config: ConfigService,
  ) {
    this.key = config.get<string>('auth.mfaEncryptionKey') ?? '';
    // Emailed codes are hashed with a server secret, so a database copy alone
    // cannot be brute-forced through a million-code space offline.
    this.pepper = config.get<string>('auth.jwtSecret') ?? '';
    // A one-step clock-drift tolerance: accept the adjacent 30s window so a
    // phone a few seconds off still verifies. Beyond that is a real mismatch.
    authenticator.options = { window: 1 };
  }

  /** Whether the authenticator-app method can work (the encryption key is set). */
  isConfigured(): boolean {
    return this.key.trim().length > 0;
  }

  /** Whether the email-code method can work (email sending is switched on). */
  emailAvailable(): boolean {
    return this.mail.available;
  }

  /**
   * Whether ANY method can be set up on this server. Admin enforcement keys
   * off this: with neither method available nobody could comply, so enforcing
   * it would lock every admin out.
   */
  canEnrol(): boolean {
    return this.isConfigured() || this.emailAvailable();
  }

  async status(userId: number) {
    const row = await this.repository.findByUser(userId);
    return {
      enrolled: Boolean(row),
      enabled: Boolean(row?.enabledAt),
      method: row?.enabledAt ? (row.method as MfaMethod) : null,
      pending_method: (row?.pendingMethod as MfaMethod | null) ?? null,
      methods_available: {
        totp: this.isConfigured(),
        email: this.emailAvailable(),
      },
    };
  }

  /** True only for an ACTIVE enrolment whose method can still work. */
  async isEnabledForLogin(userId: number): Promise<boolean> {
    const row = await this.repository.findByUser(userId);
    if (!row?.enabledAt) return false;
    return row.method === 'email' ? this.emailAvailable() : this.isConfigured();
  }

  /** The active method, for the sign-in step. */
  async methodFor(userId: number): Promise<MfaMethod> {
    const row = await this.repository.findByUser(userId);
    return (row?.method as MfaMethod) ?? 'totp';
  }

  /**
   * Step 1. For the app: a new secret, stored pending, and the QR to scan.
   * For email: the method recorded pending and a code sent to the person.
   */
  async setup(userId: number, email: string, method: MfaMethod = 'totp') {
    if (method === 'email') {
      if (!this.emailAvailable()) {
        throw new ServiceUnavailableException('Email codes are not available on this server.');
      }
      await this.repository.setPending(userId, 'email', null);
      const sentTo = await this.sendCode(userId, 'enrol');
      return { method: 'email' as const, sentTo };
    }
    this.assertConfigured();
    const secret = authenticator.generateSecret();
    await this.repository.setPending(userId, 'totp', encryptSecret(secret, this.key));
    const otpauthUrl = authenticator.keyuri(email, ISSUER, secret);
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
    return { method: 'totp' as const, secret, otpauthUrl, qrDataUrl };
  }

  /** Step 2: check a first code for the PENDING method, then make it active. */
  async enable(userId: number, code: string): Promise<{ recoveryCodes: string[]; method: MfaMethod }> {
    const row = await this.repository.findByUser(userId);
    if (!row?.pendingMethod) {
      throw new UnprocessableEntityException('Start setup first, then enter the code.');
    }
    const method = row.pendingMethod as MfaMethod;
    const ok =
      method === 'email'
        ? await this.checkEmailCode(userId, 'enrol', code)
        : this.checkTotp(code, this.decrypt(row.pendingSecret ?? ''));
    if (!ok) {
      throw new UnprocessableEntityException('That code is not valid. Try again.');
    }

    const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () => this.makeRecoveryCode());
    const hashed: RecoveryCode[] = plain.map((c) => ({ hash: hashRecoveryCode(c), used_at: null }));
    await this.repository.activatePending(userId, hashed);
    this.logger.warn(`Two-step sign-in (${method}) enabled for user ${userId}`);
    return { recoveryCodes: plain, method };
  }

  /** Turn it off, after proving a current code or a recovery code. */
  async disable(userId: number, code: string): Promise<{ ok: true }> {
    const row = await this.repository.findByUser(userId);
    if (!row || !row.enabledAt) {
      throw new UnprocessableEntityException('Two-step sign-in is not on for this account.');
    }
    if (!(await this.verifyCode(userId, code))) {
      throw new UnprocessableEntityException('That code is not valid.');
    }
    await this.repository.remove(userId);
    this.logger.warn(`Two-step sign-in disabled for user ${userId}`);
    return { ok: true };
  }

  /**
   * At sign-in, for the email method: send the code. Returns where it went,
   * masked, for the screen. Throws (503) if it could not be sent; the person
   * can still use a recovery code.
   */
  async startLoginChallenge(userId: number): Promise<string> {
    return this.sendCode(userId, 'login');
  }

  /**
   * Verify a sign-in second factor: the active method's code, or a single-use
   * recovery code. Consuming a recovery code marks it spent.
   */
  async verifyCode(userId: number, code: string): Promise<boolean> {
    const row = await this.repository.findByUser(userId);
    if (!row || !row.enabledAt) return false;

    if (row.method === 'email') {
      if (await this.checkEmailCode(userId, 'login', code)) return true;
    } else if (this.isConfigured() && row.secret) {
      if (this.checkTotp(code, this.decrypt(row.secret))) return true;
    }

    // Not a valid code for the method: try the recovery codes.
    const hash = hashRecoveryCode(code);
    const codes = row.recoveryCodes ?? [];
    const match = codes.find((c) => c.hash === hash && !c.used_at);
    if (!match) return false;
    match.used_at = new Date().toISOString();
    await this.repository.setRecoveryCodes(userId, codes);
    this.logger.warn(`Recovery code consumed for user ${userId}`);
    return true;
  }

  /* ── emailed codes ─────────────────────────────────────────────────── */

  private async sendCode(userId: number, purpose: 'enrol' | 'login'): Promise<string> {
    const recent = await this.repository.codesIssuedSince(userId, purpose, EMAIL_CODE_WINDOW_MINUTES);
    if (recent >= EMAIL_CODES_PER_WINDOW) {
      throw new HttpException(
        { message: `Too many codes requested. Wait ${EMAIL_CODE_WINDOW_MINUTES} minutes, or use a recovery code.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const contact = await this.repository.contactFor(userId);
    if (!contact) throw new UnprocessableEntityException('Account not found.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.repository.issueCode(userId, purpose, this.hashCode(userId, purpose, code), EMAIL_CODE_MINUTES);
    await this.mail.sendSignInCode({
      userId,
      organizationId: contact.organization_id,
      toEmail: contact.email,
      toName: contact.first_name,
      orgName: contact.org_name,
      code,
      minutes: EMAIL_CODE_MINUTES,
      purpose,
    });
    return maskEmail(contact.email);
  }

  private async checkEmailCode(userId: number, purpose: string, code: string): Promise<boolean> {
    const digits = (code ?? '').replace(/\D/g, '');
    if (digits.length !== 6) return false;
    const live = await this.repository.liveCode(userId, purpose, EMAIL_CODE_MAX_ATTEMPTS);
    if (!live) return false;
    const expected = Buffer.from(live.code_hash, 'hex');
    const given = Buffer.from(this.hashCode(userId, purpose, digits), 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      await this.repository.markCodeUsed(live.id);
      return true;
    }
    await this.repository.countFailedAttempt(live.id);
    return false;
  }

  private hashCode(userId: number, purpose: string, code: string): string {
    return createHmac('sha256', this.pepper).update(`${userId}:${purpose}:${code}`).digest('hex');
  }

  /* ── authenticator app ─────────────────────────────────────────────── */

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      this.logger.warn('Authenticator setup requested but MFA_ENCRYPTION_KEY is not set');
      throw new ServiceUnavailableException(
        'Authenticator-app sign-in is not configured on this server. Use email codes instead.',
      );
    }
  }

  private checkTotp(code: string, secret: string): boolean {
    const digits = (code ?? '').replace(/\D/g, '');
    if (digits.length !== 6 || !secret) return false;
    try {
      return authenticator.check(digits, secret);
    } catch {
      return false;
    }
  }

  private decrypt(stored: string): string {
    try {
      return decryptSecret(stored, this.key);
    } catch {
      // A key rotation or tampering: surface as a server error, never a
      // silent "code invalid" that would look like the user's fault.
      throw new BadRequestException('Stored two-step secret could not be read. Contact an administrator.');
    }
  }

  /** `xxxxx-xxxxx`: 10 hex chars in two groups, easy to read back from paper. */
  private makeRecoveryCode(): string {
    const hex = randomBytes(5).toString('hex');
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  }
}

/** "priya@acme.com" -> "p****@acme.com", for the screen. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.charAt(0)}${'*'.repeat(Math.max(3, local.length - 1))}@${domain}`;
}
