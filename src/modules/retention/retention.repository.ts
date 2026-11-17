import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

/**
 * Queries behind the retention sweep. Raw SQL, snake_case throughout — no
 * casing seam (§10.10).
 *
 * Platform-org users are deliberately excluded: that organization owns the
 * product's own operators, and anonymising a platform admin on the same
 * schedule as a customer's ex-employee is not what the obligation is about.
 */
@Injectable()
export class RetentionRepository {
  constructor(private readonly database: DatabaseService) {}
  private get db() {
    return this.database.db;
  }

  /** Deactivated, not-yet-anonymised users whose window has elapsed. */
  async countAnonymizationCandidates(cutoffIso: string): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT count(*)::int AS n
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
      WHERE u.is_active = 0
        AND u.anonymized_at IS NULL
        AND u.deactivated_at IS NOT NULL
        AND u.deactivated_at < ${cutoffIso}
        AND o.is_platform = false
    `);
    return rows[0]?.n ?? 0;
  }

  async findAnonymizationCandidates(
    cutoffIso: string,
    limit: number,
  ): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT u.id
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
      WHERE u.is_active = 0
        AND u.anonymized_at IS NULL
        AND u.deactivated_at IS NOT NULL
        AND u.deactivated_at < ${cutoffIso}
        AND o.is_platform = false
      ORDER BY u.deactivated_at
      LIMIT ${limit}
    `);
    return rows.map((r) => r.id);
  }

  /**
   * Irreversibly strip PII from these users, keeping the row for referential
   * integrity. The email is tombstoned to a unique, non-routable value so the
   * UNIQUE constraint holds; the password is set to a value that is not a valid
   * scrypt `<hex>.<hex>` pair, so it can never verify.
   */
  async anonymize(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    // A JS array interpolates as a SQL record, not an array literal, so build
    // an explicit IN list (the §10.x casing/array trap).
    const idList = sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    );
    await this.db.run(sql`
      UPDATE users SET
        first_name      = 'Deleted',
        last_name       = 'User',
        email           = 'deleted+' || id || '@retention.invalid',
        password        = 'anonymized',
        department      = NULL,
        employee_id     = NULL,
        location        = NULL,
        job_role        = NULL,
        job_level       = NULL,
        phone           = NULL,
        avatar_url      = NULL,
        consent_version = NULL,
        consented_at    = NULL,
        anonymized_at   = now()
      WHERE id IN (${idList})
    `);
    /*
     * The consent log (0065) keeps its rows as the record of what was agreed,
     * but the IP address and browser string are personal data that outlive
     * their purpose once the person is anonymised.
     */
    await this.db.run(sql`
      UPDATE consent_events SET ip_address = NULL, user_agent = NULL
      WHERE user_id IN (${idList})
    `);
    return ids.length;
  }
}
