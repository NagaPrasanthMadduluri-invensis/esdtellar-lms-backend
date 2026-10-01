import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

export interface ResetTokenRow {
  id: number;
  user_id: number;
  organization_id: number;
  email: string;
  first_name: string | null;
  expires_at: string;
  used_at: string | null;
}

/**
 * Password-reset tokens.
 *
 * Separate from `AuthRepository` because the questions are different:
 * that one answers "who is this signed-in person", this one answers
 * "is this opaque string a valid claim on an account". Keeping them apart
 * also keeps `findActiveByEmailWithSecret` — the method that selects a
 * password hash — away from a flow that never needs it.
 */
@Injectable()
export class PasswordResetRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Looks a person up by email across EVERY organization.
   *
   * Unscoped, deliberately and unavoidably: somebody who has forgotten
   * their password cannot tell us which tenant they belong to, and
   * `users.email` is globally unique so there is exactly one answer. The
   * org travels back on the row so everything after this point is scoped
   * again.
   */
  async findActiveByEmail(email: string): Promise<{
    id: number;
    organization_id: number;
    email: string;
    first_name: string | null;
  } | null> {
    const [row] = await this.db.all<{
      id: number;
      organization_id: number;
      email: string;
      first_name: string | null;
    }>(sql`
      SELECT u.id, u.organization_id, u.email, u.first_name
        FROM users u
        JOIN organizations o ON o.id = u.organization_id
       WHERE LOWER(u.email) = ${email.toLowerCase()}
         AND u.is_active = 1
         AND o.is_active = 1
       LIMIT 1
    `);
    return row ?? null;
  }

  /**
   * Invalidates every outstanding token for this user, then issues one.
   *
   * The invalidation is the security-relevant half. Without it, asking for
   * three resets leaves three live tokens, and the two the person did not
   * use stay valid in whatever inbox, log or proxy they passed through.
   * One live token per account at a time.
   */
  async issue(
    userId: number,
    tokenHash: string,
    expiresAt: Date,
    requestedIp: string | null,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE password_reset_tokens
         SET used_at = NOW()
       WHERE user_id = ${userId} AND used_at IS NULL
    `);
    await this.db.run(sql`
      INSERT INTO password_reset_tokens
        (user_id, token_hash, expires_at, requested_ip)
      VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()}, ${requestedIp})
    `);
  }

  /** How many this user has asked for in the window — the rate limit. */
  async recentCount(userId: number, minutes: number): Promise<number> {
    const [row] = await this.db.all<{ n: string }>(sql`
      SELECT COUNT(*) AS n FROM password_reset_tokens
       WHERE user_id = ${userId}
         AND created_at > NOW() - (${minutes} * INTERVAL '1 minute')
    `);
    return Number(row?.n ?? 0);
  }

  /**
   * Resolves a token hash to its row, used or not, expired or not.
   *
   * It deliberately returns rows it will not accept, so the service can
   * tell "already used" and "expired" apart from "never existed" — three
   * different sentences, and the first two are far more useful to somebody
   * staring at a link that did not work.
   */
  async findByHash(tokenHash: string): Promise<ResetTokenRow | null> {
    const [row] = await this.db.all<ResetTokenRow>(sql`
      SELECT t.id, t.user_id, t.expires_at, t.used_at,
             u.organization_id, u.email, u.first_name
        FROM password_reset_tokens t
        JOIN users u ON u.id = t.user_id
        JOIN organizations o ON o.id = u.organization_id
       WHERE t.token_hash = ${tokenHash}
         AND u.is_active = 1
         AND o.is_active = 1
       LIMIT 1
    `);
    return row ?? null;
  }

  /**
   * Consumes the token and sets the password IN ONE STATEMENT EACH, with
   * the consume first.
   *
   * Order matters: if the password write fails, the token is already spent
   * and the person asks for another. The opposite order would leave a live
   * token on an account whose password has already changed.
   */
  async consume(tokenId: number): Promise<boolean> {
    const rows = await this.db.all<{ id: string }>(sql`
      UPDATE password_reset_tokens
         SET used_at = NOW()
       WHERE id = ${tokenId} AND used_at IS NULL
      RETURNING id
    `);
    // Zero rows means somebody else consumed it between the read and here.
    return rows.length === 1;
  }

  /**
   * Sets the password and bumps the user's token version.
   *
   * The bump is what signs out every existing session. Somebody resetting
   * a password they believe was compromised and finding the attacker still
   * signed in would make the whole flow pointless.
   */
  async setPassword(userId: number, passwordHash: string): Promise<void> {
    await this.db.run(sql`
      UPDATE users
         SET password = ${passwordHash},
             perm_version = COALESCE(perm_version, 0) + 1
       WHERE id = ${userId}
    `);
  }
}
