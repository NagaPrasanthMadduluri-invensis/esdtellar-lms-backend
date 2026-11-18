import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { userMfa, type RecoveryCode, type UserMfaRow } from '@/database/schema';

/**
 * The one place `user_mfa` is read or written. Not org-scoped, like the rest of
 * the auth repository: MFA is keyed by the `user_id` the service already
 * resolved from the verified token or a challenge (§3.3).
 */
@Injectable()
export class MfaRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async findByUser(userId: number): Promise<UserMfaRow | null> {
    const rows = await this.db
      .select()
      .from(userMfa)
      .where(eq(userMfa.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record a method being SET UP, without touching the active one (0069).
   * Switching from the app to email (or back) therefore never removes the
   * protection someone already has until the new method is confirmed.
   */
  async setPending(userId: number, method: string, encryptedSecret: string | null): Promise<void> {
    await this.db
      .insert(userMfa)
      .values({ userId, method, pendingMethod: method, pendingSecret: encryptedSecret })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: { pendingMethod: method, pendingSecret: encryptedSecret, updatedAt: sql`now()` },
      });
  }

  /** Make the pending method the active one, with fresh recovery codes. */
  async activatePending(userId: number, recoveryCodes: RecoveryCode[]): Promise<void> {
    await this.db.execute(sql`
      UPDATE user_mfa
         SET method = pending_method,
             secret = pending_secret,
             pending_method = NULL,
             pending_secret = NULL,
             enabled_at = COALESCE(enabled_at, now()),
             recovery_codes = ${JSON.stringify(recoveryCodes)}::jsonb,
             updated_at = now()
       WHERE user_id = ${userId} AND pending_method IS NOT NULL`);
  }

  /** Name, address and organization for the code email. Never the password. */
  async contactFor(userId: number) {
    const [row] = await this.db.all<{
      email: string; first_name: string | null; organization_id: number; org_name: string | null;
    }>(sql`
      SELECT u.email, u.first_name, u.organization_id, o.name AS org_name
        FROM users u JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = ${userId}`);
    return row ?? null;
  }

  /* ── emailed codes (0069): stored only as a keyed hash ─────────────── */

  async codesIssuedSince(userId: number, purpose: string, minutes: number): Promise<number> {
    const [row] = await this.db.all<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM mfa_email_codes
       WHERE user_id = ${userId} AND purpose = ${purpose}
         AND created_at > now() - (${minutes} * INTERVAL '1 minute')`);
    return row?.n ?? 0;
  }

  /** Store a new code and retire every earlier unused one for that purpose. */
  async issueCode(userId: number, purpose: string, codeHash: string, minutes: number): Promise<void> {
    await this.db.run(sql`
      UPDATE mfa_email_codes SET used_at = now()
       WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL`);
    await this.db.run(sql`
      INSERT INTO mfa_email_codes (user_id, purpose, code_hash, expires_at)
      VALUES (${userId}, ${purpose}, ${codeHash}, now() + (${minutes} * INTERVAL '1 minute'))`);
  }

  /** The live code for a purpose: unused, unexpired, attempts left. */
  async liveCode(userId: number, purpose: string, maxAttempts: number) {
    const [row] = await this.db.all<{ id: number; code_hash: string }>(sql`
      SELECT id, code_hash FROM mfa_email_codes
       WHERE user_id = ${userId} AND purpose = ${purpose}
         AND used_at IS NULL AND expires_at > now() AND attempts < ${maxAttempts}
       ORDER BY created_at DESC LIMIT 1`);
    return row ?? null;
  }

  async markCodeUsed(id: number): Promise<void> {
    await this.db.run(sql`UPDATE mfa_email_codes SET used_at = now() WHERE id = ${id}`);
  }

  async countFailedAttempt(id: number): Promise<void> {
    await this.db.run(sql`UPDATE mfa_email_codes SET attempts = attempts + 1 WHERE id = ${id}`);
  }

  /** Rewrite the recovery-code set (used when one is consumed). */
  async setRecoveryCodes(
    userId: number,
    recoveryCodes: RecoveryCode[],
  ): Promise<void> {
    await this.db
      .update(userMfa)
      .set({ recoveryCodes, updatedAt: sql`now()` })
      .where(eq(userMfa.userId, userId));
  }

  async remove(userId: number): Promise<void> {
    await this.db.delete(userMfa).where(eq(userMfa.userId, userId));
  }
}
