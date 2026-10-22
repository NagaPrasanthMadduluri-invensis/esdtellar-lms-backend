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
   * Store (or replace) a PENDING enrolment: the encrypted secret, no
   * `enabled_at`, no recovery codes. Re-running setup overwrites a half-finished
   * enrolment rather than stacking rows.
   */
  async upsertPending(userId: number, encryptedSecret: string): Promise<void> {
    await this.db
      .insert(userMfa)
      .values({ userId, secret: encryptedSecret })
      .onConflictDoUpdate({
        target: userMfa.userId,
        set: {
          secret: encryptedSecret,
          enabledAt: null,
          recoveryCodes: [],
          updatedAt: sql`now()`,
        },
      });
  }

  /** Activate the pending enrolment and store the hashed recovery codes. */
  async enable(userId: number, recoveryCodes: RecoveryCode[]): Promise<void> {
    await this.db
      .update(userMfa)
      .set({
        enabledAt: sql`now()`,
        recoveryCodes,
        updatedAt: sql`now()`,
      })
      .where(eq(userMfa.userId, userId));
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
