import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { idList } from '@/database/id-list';

export interface ResetTokenRow {
  id: number;
  user_id: number;
  organization_id: number;
  email: string;
  first_name: string | null;
  expires_at: string;
  used_at: string | null;
  /** 'welcome' | 'reset' — 0045. */
  purpose: string;
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
  /**
   * Issue MANY one-time tokens in two statements, whatever the batch size.
   *
   * `issue()` above is two round trips per person. The bulk import creates
   * up to 500 learners in one request, so calling it per row would be 1,000
   * round trips inside a single HTTP request — the N+1 §7.1 forbids, on the
   * path that is already the slowest in the product (it runs `scryptSync`
   * per row). This is two, for any size of file.
   *
   * The invalidation is the same rule the single version applies, expressed
   * set-wise: issuing a new token voids every outstanding one for that
   * person, so a learner who is somehow imported twice cannot end up with
   * two live links.
   */
  /**
   * Learners still owed a welcome email after a grace window — the sweep's
   * input (§10.33).
   *
   * On the users table, which this repository already reads and writes
   * (findByEmail, setPassword), so no module boundary is crossed to get it.
   * The grace window matters: the happy path clears the flag seconds after
   * the request sets it, so a flag older than a few minutes is a genuine
   * straggler, not a request still in flight.
   */
  async findPendingWelcomes(
    olderThanMinutes: number,
    limit: number,
  ): Promise<
    { id: number; email: string; organizationId: number; firstName: string | null }[]
  > {
    const rows = await this.db.execute(sql`
      SELECT u.id, u.email, u.organization_id AS "organizationId",
             u.first_name AS "firstName"
        FROM users u
       WHERE u.welcome_pending_since IS NOT NULL
         AND u.welcome_pending_since < now() - (${olderThanMinutes} || ' minutes')::interval
       ORDER BY u.welcome_pending_since
       LIMIT ${limit}
    `);
    return rows.rows as {
      id: number; email: string; organizationId: number; firstName: string | null;
    }[];
  }

  /** Clear the marker — a welcome has been queued, or already existed. */
  async clearWelcomePending(userIds: number[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.db.run(sql`
      UPDATE users SET welcome_pending_since = NULL
       WHERE id IN ${idList(userIds)}
    `);
  }

  async issueMany(
    rows: { userId: number; tokenHash: string; expiresAt: Date }[],
  ): Promise<void> {
    if (rows.length === 0) return;

    /*
     * `idList`, never a bare array. Interpolating one expands it as a ROW
     * CONSTRUCTOR, so this read `ANY((1,2,3)::int[])` and Postgres refused
     * with "cannot cast type record to integer[]" — and because the whole
     * send is best-effort, that surfaced as six accounts created and
     * nobody emailed, with a single `warn` as the only sign. §10.15
     * records the same quirk in three other repositories.
     */
    await this.db.run(sql`
      UPDATE password_reset_tokens
         SET used_at = NOW()
       WHERE user_id IN ${idList(rows.map((r) => r.userId))}
         AND used_at IS NULL
    `);

    const values = sql.join(
      rows.map(
        // issueMany is the welcome path only (sendWelcomeMany), hence the literal.
        (r) => sql`(${r.userId}, ${r.tokenHash}, ${r.expiresAt.toISOString()}, NULL, 'welcome')`,
      ),
      sql`, `,
    );
    await this.db.run(sql`
      INSERT INTO password_reset_tokens
        (user_id, token_hash, expires_at, requested_ip, purpose)
      VALUES ${values}
    `);
  }

  async issue(
    userId: number,
    tokenHash: string,
    expiresAt: Date,
    requestedIp: string | null,
    purpose: 'welcome' | 'reset' = 'reset',
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE password_reset_tokens
         SET used_at = NOW()
       WHERE user_id = ${userId} AND used_at IS NULL
    `);
    await this.db.run(sql`
      INSERT INTO password_reset_tokens
        (user_id, token_hash, expires_at, requested_ip, purpose)
      VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()}, ${requestedIp}, ${purpose})
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
      SELECT t.id, t.user_id, t.expires_at, t.used_at, t.purpose,
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
