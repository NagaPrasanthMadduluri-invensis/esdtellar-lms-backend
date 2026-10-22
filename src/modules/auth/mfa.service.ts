import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authenticator } from 'otplib';

import {
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
} from '@/common/crypto/secret-box.util';
import type { RecoveryCode } from '@/database/schema';
import * as qrcode from 'qrcode';

import { MfaRepository } from './mfa.repository';

const ISSUER = 'Spectra LMS';
const RECOVERY_CODE_COUNT = 10;

/**
 * TOTP multi-factor for admin accounts (0058).
 *
 * The secret is encrypted at rest (MFA_ENCRYPTION_KEY). Enrolment is two steps —
 * `setup` stores a PENDING secret and returns the QR, `enable` verifies a first
 * code and only then activates it and mints recovery codes — so a secret the
 * user never managed to scan can never start challenging them at login.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);
  private readonly key: string;

  constructor(
    private readonly repository: MfaRepository,
    config: ConfigService,
  ) {
    this.key = config.get<string>('auth.mfaEncryptionKey') ?? '';
    // A one-step clock-drift tolerance: accept the adjacent 30s window so a
    // phone a few seconds off still verifies. Beyond that is a real mismatch.
    authenticator.options = { window: 1 };
  }

  /** Whether MFA can operate at all — the encryption key must be configured. */
  isConfigured(): boolean {
    return this.key.trim().length > 0;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      this.logger.warn('MFA requested but MFA_ENCRYPTION_KEY is not set');
      throw new ServiceUnavailableException(
        'Multi-factor authentication is not configured on this server.',
      );
    }
  }

  async status(userId: number): Promise<{ enrolled: boolean; enabled: boolean }> {
    const row = await this.repository.findByUser(userId);
    return {
      enrolled: Boolean(row),
      enabled: Boolean(row?.enabledAt),
    };
  }

  /** True only for an ACTIVE enrolment — the login challenge reads this. */
  async isEnabledForLogin(userId: number): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const row = await this.repository.findByUser(userId);
    return Boolean(row?.enabledAt);
  }

  /** Step 1: generate a secret, store it PENDING, and return the QR to scan. */
  async setup(
    userId: number,
    email: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    this.assertConfigured();
    const secret = authenticator.generateSecret();
    await this.repository.upsertPending(userId, encryptSecret(secret, this.key));
    const otpauthUrl = authenticator.keyuri(email, ISSUER, secret);
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);
    return { secret, otpauthUrl, qrDataUrl };
  }

  /** Step 2: verify a first code, activate, and return one-time recovery codes. */
  async enable(userId: number, code: string): Promise<{ recoveryCodes: string[] }> {
    this.assertConfigured();
    const row = await this.repository.findByUser(userId);
    if (!row) {
      throw new UnprocessableEntityException(
        'Start setup first, then enter a code from your authenticator app.',
      );
    }
    const secret = this.decrypt(row.secret);
    if (!this.checkTotp(code, secret)) {
      throw new UnprocessableEntityException('That code is not valid. Try again.');
    }

    const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      this.makeRecoveryCode(),
    );
    const hashed: RecoveryCode[] = plain.map((c) => ({
      hash: hashRecoveryCode(c),
      used_at: null,
    }));
    await this.repository.enable(userId, hashed);
    this.logger.warn(`MFA enabled for user ${userId}`);
    return { recoveryCodes: plain };
  }

  /** Turn MFA off, after proving a current code or recovery code. */
  async disable(userId: number, code: string): Promise<{ ok: true }> {
    const row = await this.repository.findByUser(userId);
    if (!row || !row.enabledAt) {
      throw new UnprocessableEntityException('MFA is not enabled on this account.');
    }
    const ok = await this.verifyCode(userId, code);
    if (!ok) {
      throw new UnprocessableEntityException('That code is not valid.');
    }
    await this.repository.remove(userId);
    this.logger.warn(`MFA disabled for user ${userId}`);
    return { ok: true };
  }

  /**
   * Verify a login second factor: a TOTP code, or a single-use recovery code.
   * Consuming a recovery code marks it spent. Used by the MFA-verify step.
   */
  async verifyCode(userId: number, code: string): Promise<boolean> {
    if (!this.isConfigured()) return false;
    const row = await this.repository.findByUser(userId);
    if (!row || !row.enabledAt) return false;

    const secret = this.decrypt(row.secret);
    if (this.checkTotp(code, secret)) return true;

    // Not a valid TOTP — try the recovery codes.
    const hash = hashRecoveryCode(code);
    const codes = row.recoveryCodes ?? [];
    const match = codes.find((c) => c.hash === hash && !c.used_at);
    if (!match) return false;

    match.used_at = new Date().toISOString();
    await this.repository.setRecoveryCodes(userId, codes);
    this.logger.warn(`MFA recovery code consumed for user ${userId}`);
    return true;
  }

  private checkTotp(code: string, secret: string): boolean {
    const digits = (code ?? '').replace(/\D/g, '');
    if (digits.length !== 6) return false;
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
      // A key rotation or tampering — surface as a server error, never a
      // silent "code invalid" that would look like the user's fault.
      throw new BadRequestException(
        'Stored MFA secret could not be read. Contact an administrator.',
      );
    }
  }

  /** `xxxxx-xxxxx`: 10 hex chars in two groups, easy to read back from paper. */
  private makeRecoveryCode(): string {
    const hex = randomBytes(5).toString('hex');
    return `${hex.slice(0, 5)}-${hex.slice(5)}`;
  }
}
