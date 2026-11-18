import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

/** Files on disk that a scrub released; the service deletes them after commit. */
export interface ReleasedFiles {
  avatars: string[];
  shared: string[];
  certificates: string[];
}

/** One time-limited category: how to count what is due, and how to delete it. */
export interface PurgeCategory {
  key: string;
  days: number;
}

const TOMBSTONE = 'Deleted User';

/**
 * Queries behind the retention sweep (0063, extended by 0067). Raw SQL,
 * snake_case throughout (§10.10).
 *
 * THREE jobs, all driven by RetentionService and all behind its two guards
 * (RETENTION_ENABLED, RETENTION_DRY_RUN):
 *
 *  1. ANONYMISE a person everywhere their identity was copied, not only the
 *     users row. See `anonymizeUser` for the full list and the one deliberate
 *     exception (direct messages are KEPT, the owner's decision 2026-11-18).
 *  2. PURGE time-limited categories for everybody, active or not, on the
 *     schedule in privacy-pack document 03.
 *  3. OFFBOARD an organization whose data deletion date has passed.
 *
 * Platform-org users are never anonymised: they are the product's own
 * operators, not a customer's ex-employees.
 */
@Injectable()
export class RetentionRepository {
  constructor(private readonly database: DatabaseService) {}
  private get db() {
    return this.database.db;
  }

  /* ── 1. Who is due ─────────────────────────────────────────────────── */

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

  async findAnonymizationCandidates(cutoffIso: string, limit: number): Promise<number[]> {
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

  /* ── 1. Anonymise one person everywhere ───────────────────────────── */

  /**
   * Irreversibly remove one person's identity from every place it was copied,
   * in ONE transaction, and return the files that must then be deleted.
   *
   * The users row is changed LAST. Until it is, the person is still a
   * candidate, so a crash part-way through is simply redone next night with
   * the original name still available to search for.
   *
   * What happens, table by table:
   *
   * | Where | Action |
   * |---|---|
   * | users | name to the tombstone, email to a unique dummy, password unusable, PII columns cleared, last_seen cleared |
   * | audit_log | their own rows: name, email and IP cleared. Anyone's row in their org: their name/email replaced inside the recorded summary and error |
   * | activity_log | actor name replaced; their name replaced inside titles and details in their org |
   * | notifications | their own deleted; their name replaced in colleagues' |
   * | email_outbox | their own deleted; their name replaced in colleagues' |
   * | community | their posts and replies: content blanked, removed, files released. Their name replaced in colleagues' posts and replies |
   * | direct_messages | KEPT (owner's decision). The sender shows as the tombstone through the users row |
   * | session / course feedback | ratings kept; free-text comments deleted |
   * | external certifications | record kept, name on certificate replaced, the scan released |
   * | SCORM tracking / attempts | learner name and id removed from the saved data model |
   * | data_requests | what they wrote removed; the request's type, status and dates kept as evidence |
   * | user_mfa, reset tokens | deleted |
   * | consent_events | rows kept as the record of what was agreed; IP and browser cleared |
   *
   * A name inside free text is matched by its full form ("Priya Sharma"), the
   * public form ("Priya S.") and the email address, never the first name
   * alone: replacing a short first name would corrupt unrelated words.
   */
  async anonymizeUser(userId: number): Promise<ReleasedFiles | null> {
    const [who] = await this.db.all<{
      id: number;
      organization_id: number;
      first_name: string | null;
      last_name: string | null;
      email: string;
      avatar_url: string | null;
    }>(sql`
      SELECT id, organization_id, first_name, last_name, email, avatar_url
        FROM users WHERE id = ${userId} AND anonymized_at IS NULL
    `);
    if (!who) return null;

    const org = who.organization_id;
    const first = (who.first_name ?? '').trim();
    const last = (who.last_name ?? '').trim();
    const dummyEmail = `deleted+${who.id}@retention.invalid`;
    const needles = [
      [first, last].filter(Boolean).join(' '),
      first && last ? `${first} ${last.charAt(0)}.` : '',
    ].filter((n) => n.length >= 4);
    const emailNeedle = who.email && who.email.length >= 4 ? who.email : null;

    /** `col` with every needle replaced, and a test for "contains any". */
    const scrub = (col: SQL): SQL => {
      let out = col;
      if (emailNeedle) out = sql`replace(${out}, ${emailNeedle}, ${dummyEmail})`;
      for (const n of needles) out = sql`replace(${out}, ${n}, ${TOMBSTONE})`;
      return out;
    };
    const contains = (col: SQL): SQL => {
      const tests = [...needles, ...(emailNeedle ? [emailNeedle] : [])].map(
        (n) => sql`strpos(${col}, ${n}) > 0`,
      );
      return tests.length ? sql`(${sql.join(tests, sql` OR `)})` : sql`FALSE`;
    };

    const released: ReleasedFiles = {
      avatars: who.avatar_url ? [who.avatar_url] : [],
      shared: [],
      certificates: [],
    };

    await this.db.transaction(async (tx) => {
      const q = async <T = Record<string, unknown>>(query: SQL): Promise<T[]> =>
        ((await tx.execute(query)) as unknown as { rows: T[] }).rows;

      /* audit log */
      await q(sql`UPDATE audit_log SET actor_name = ${TOMBSTONE}, actor_email = NULL, ip = NULL
                   WHERE actor_user_id = ${userId}`);
      await q(sql`UPDATE audit_log
                     SET summary = ${scrub(sql`summary::text`)}::jsonb,
                         error_message = ${scrub(sql`error_message`)}
                   WHERE organization_id = ${org}
                     AND (${contains(sql`summary::text`)} OR ${contains(sql`coalesce(error_message, '')`)})`);

      /* activity feed */
      await q(sql`UPDATE activity_log SET actor_name = ${TOMBSTONE} WHERE actor_user_id = ${userId}`);
      await q(sql`UPDATE activity_log
                     SET title = ${scrub(sql`title`)}, detail = ${scrub(sql`detail`)}
                   WHERE organization_id = ${org}
                     AND (${contains(sql`coalesce(title, '')`)} OR ${contains(sql`coalesce(detail, '')`)})`);

      /* notifications */
      await q(sql`DELETE FROM notifications WHERE user_id = ${userId}`);
      await q(sql`UPDATE notifications
                     SET title = ${scrub(sql`title`)}, body = ${scrub(sql`body`)},
                         actor_name = ${scrub(sql`actor_name`)}
                   WHERE organization_id = ${org}
                     AND (${contains(sql`coalesce(title, '')`)} OR ${contains(sql`coalesce(body, '')`)}
                          OR ${contains(sql`coalesce(actor_name, '')`)})`);

      /* email queue */
      await q(sql`DELETE FROM email_outbox WHERE user_id = ${userId}`);
      await q(sql`UPDATE email_outbox
                     SET subject = ${scrub(sql`subject`)}, body = ${scrub(sql`body`)},
                         subject_name = ${scrub(sql`subject_name`)}, actor_name = ${scrub(sql`actor_name`)},
                         facts = ${scrub(sql`facts::text`)}::jsonb
                   WHERE organization_id = ${org}
                     AND (${contains(sql`coalesce(subject, '')`)} OR ${contains(sql`coalesce(body, '')`)}
                          OR ${contains(sql`coalesce(subject_name, '')`)} OR ${contains(sql`coalesce(actor_name, '')`)}
                          OR ${contains(sql`coalesce(facts::text, '')`)})`);

      /* community: their own content is removed, files released */
      const postFiles = await q<{ file_path: string }>(sql`
        SELECT file_path FROM community_posts WHERE user_id = ${userId} AND file_path IS NOT NULL`);
      released.shared.push(...postFiles.map((p) => p.file_path));
      await q(sql`
        UPDATE community_posts
           SET title = NULL, body = NULL, resource_url = NULL,
               file_path = NULL, file_name = NULL, file_mime = NULL, file_size = NULL,
               deleted_at = COALESCE(deleted_at, now())
         WHERE user_id = ${userId}`);
      await q(sql`UPDATE community_replies SET body = '', deleted_at = COALESCE(deleted_at, now())
                   WHERE user_id = ${userId}`);
      await q(sql`UPDATE community_posts
                     SET title = ${scrub(sql`title`)}, body = ${scrub(sql`body`)}
                   WHERE organization_id = ${org}
                     AND (${contains(sql`coalesce(title, '')`)} OR ${contains(sql`coalesce(body, '')`)})`);
      await q(sql`UPDATE community_replies SET body = ${scrub(sql`body`)}
                   WHERE organization_id = ${org} AND ${contains(sql`body`)}`);

      /* feedback: ratings stay, free text goes */
      await q(sql`UPDATE session_feedback SET comment = NULL WHERE user_id = ${userId}`);
      await q(sql`UPDATE course_feedback cf
                     SET answers = cf.answers - COALESCE((
                       SELECT array_agg(q.id::text) FROM feedback_template_questions q
                        WHERE q.template_id = cf.template_id AND q.question_type = 'text'), '{}'::text[])
                   WHERE cf.user_id = ${userId}`);

      /* external certifications: record kept, scan released */
      const certs = await q<{ file_path: string }>(sql`
        SELECT file_path FROM external_certifications
         WHERE user_id = ${userId} AND file_path <> ''`);
      released.certificates.push(...certs.map((c) => c.file_path));
      await q(sql`UPDATE external_certifications
                     SET name_on_certificate = ${TOMBSTONE}, file_path = '', file_name = 'removed'
                   WHERE user_id = ${userId}`);

      /* SCORM: the learner's name and id inside the saved data model */
      const scrubCmi = (col: SQL): SQL => sql`
        CASE WHEN pg_input_is_valid(${col}, 'jsonb') THEN
          jsonb_set(jsonb_set(jsonb_set(jsonb_set(${col}::jsonb,
            '{core,student_name}', '""', false), '{core,student_id}', '""', false),
            '{learner_name}', '""', false), '{learner_id}', '""', false)::text
        ELSE ${col} END`;
      await q(sql`UPDATE scorm_tracking SET cmi_data = ${scrubCmi(sql`cmi_data`)}
                   WHERE user_id = ${userId} AND cmi_data IS NOT NULL`);
      await q(sql`UPDATE scorm_attempts SET cmi_data = ${scrubCmi(sql`cmi_data`)}
                   WHERE user_id = ${userId} AND cmi_data IS NOT NULL`);

      /* privacy requests: keep the evidence, drop what they wrote */
      await q(sql`UPDATE data_requests SET details = NULL WHERE user_id = ${userId}`);

      /* credentials */
      await q(sql`DELETE FROM user_mfa WHERE user_id = ${userId}`);
      await q(sql`DELETE FROM password_reset_tokens WHERE user_id = ${userId}`);

      /* consent log: rows kept, who-clicked evidence cleared */
      await q(sql`UPDATE consent_events SET ip_address = NULL, user_agent = NULL WHERE user_id = ${userId}`);

      /* the account itself, LAST */
      await q(sql`
        UPDATE users SET
          first_name      = 'Deleted',
          last_name       = 'User',
          email           = ${dummyEmail},
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
          last_seen_at    = NULL,
          is_active       = 0,
          anonymized_at   = now()
        WHERE id = ${userId}`);
    });

    return released;
  }

  /* ── 2. Time-limited categories (privacy-pack document 03) ─────────── */

  /**
   * The predicate for every purge category, written ONCE so the dry-run count
   * and the delete can never disagree about what is due.
   */
  private purgeWhere(key: string, days: number): { table: string; where: SQL } {
    const before = sql`now() - (${days} * INTERVAL '1 day')`;
    switch (key) {
      case 'audit_log':
        return { table: 'audit_log', where: sql`created_at < ${before}` };
      case 'activity_log':
        return { table: 'activity_log', where: sql`created_at < ${before}` };
      case 'scorm_datamodel_log':
        return { table: 'scorm_datamodel_log', where: sql`created_at < ${before}` };
      case 'notifications_read':
        return { table: 'notifications', where: sql`read_at IS NOT NULL AND created_at < ${before}` };
      case 'notifications_unread':
        return { table: 'notifications', where: sql`read_at IS NULL AND created_at < ${before}` };
      case 'failed_emails':
        return { table: 'email_outbox', where: sql`status = 'failed' AND enqueued_at < ${before}` };
      case 'closed_data_requests':
        return {
          table: 'data_requests',
          where: sql`status IN ('resolved', 'rejected') AND coalesce(handled_at, updated_at) < ${before}`,
        };
      case 'reset_tokens':
        return { table: 'password_reset_tokens', where: sql`expires_at < ${before}` };
      case 'removed_community_replies':
        return { table: 'community_replies', where: sql`deleted_at IS NOT NULL AND deleted_at < ${before}` };
      case 'removed_community_posts':
        return { table: 'community_posts', where: sql`deleted_at IS NOT NULL AND deleted_at < ${before}` };
      case 'stale_referrals':
        return {
          table: 'referrals',
          where: sql`status <> 'converted' AND updated_at < ${before}`,
        };
      default:
        throw new Error(`Unknown retention category ${key}`);
    }
  }

  async countDue(key: string, days: number): Promise<number> {
    const { table, where } = this.purgeWhere(key, days);
    const [row] = await this.db.all<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${where}`,
    );
    return row?.n ?? 0;
  }

  /**
   * Delete one batch of a category. Returns the rows deleted and, for removed
   * community posts, the files they held. Batched so a first run against a
   * year of audit rows never holds one huge lock.
   */
  async purgeBatch(key: string, days: number, limit = 5000): Promise<{ deleted: number; files: string[] }> {
    const { table, where } = this.purgeWhere(key, days);
    const t = sql.identifier(table);
    const rows = await this.db.all<{ file_path: string | null }>(sql`
      DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${where} LIMIT ${limit})
      RETURNING ${key === 'removed_community_posts' ? sql`file_path` : sql`NULL::text AS file_path`}`);
    return {
      deleted: rows.length,
      files: rows.map((r) => r.file_path).filter((p): p is string => Boolean(p)),
    };
  }

  /**
   * External certification scans 12 months after the final decision: the
   * file goes, the record (course, hours, decision) stays.
   */
  async countDueCertificateFiles(days: number): Promise<number> {
    const [row] = await this.db.all<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM external_certifications
       WHERE file_path <> '' AND status IN ('approved', 'rejected')
         AND coalesce(admin_decided_at, manager_decided_at, updated_at) < now() - (${days} * INTERVAL '1 day')`);
    return row?.n ?? 0;
  }

  async releaseDueCertificateFiles(days: number, limit = 500): Promise<string[]> {
    const rows = await this.db.all<{ old_path: string }>(sql`
      WITH due AS (
        SELECT id, file_path AS old_path FROM external_certifications
         WHERE file_path <> '' AND status IN ('approved', 'rejected')
           AND coalesce(admin_decided_at, manager_decided_at, updated_at) < now() - (${days} * INTERVAL '1 day')
         LIMIT ${limit}
      )
      UPDATE external_certifications ec SET file_path = '', file_name = 'removed'
        FROM due WHERE ec.id = due.id
      RETURNING due.old_path`);
    return rows.map((r) => r.old_path);
  }

  /* ── 3. Client offboarding ────────────────────────────────────────── */

  /** Organizations whose scheduled deletion date has passed and not yet run. */
  async organizationsDueForDeletion(): Promise<Array<{ id: number; name: string }>> {
    return this.db.all(sql`
      SELECT id, name FROM organizations
       WHERE data_deletion_due_at IS NOT NULL
         AND data_deletion_due_at <= now()
         AND data_deleted_at IS NULL
         AND is_platform = false
       ORDER BY data_deletion_due_at`);
  }

  /** Every not-yet-anonymised person in an organization, active or not. */
  async usersOfOrganization(organizationId: number, limit: number): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM users
       WHERE organization_id = ${organizationId} AND anonymized_at IS NULL
       ORDER BY id LIMIT ${limit}`);
    return rows.map((r) => r.id);
  }

  async countUsersOfOrganization(organizationId: number): Promise<number> {
    const [row] = await this.db.all<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM users
       WHERE organization_id = ${organizationId} AND anonymized_at IS NULL`);
    return row?.n ?? 0;
  }

  /**
   * After every person is anonymised, remove the organization's remaining
   * communications and logs. Direct messages are kept for an INDIVIDUAL's
   * anonymisation, but when the whole client leaves there is nobody left for
   * them to serve, so here they go. Courses and other content the client
   * authored are not personal data and are left in place.
   */
  async purgeOrganization(organizationId: number): Promise<{ files: string[] }> {
    const files: string[] = [];
    await this.db.transaction(async (tx) => {
      const q = async <T = Record<string, unknown>>(query: SQL): Promise<T[]> =>
        ((await tx.execute(query)) as unknown as { rows: T[] }).rows;
      const dm = await q<{ file_path: string | null }>(sql`
        DELETE FROM direct_messages WHERE organization_id = ${organizationId} RETURNING file_path`);
      const posts = await q<{ file_path: string | null }>(sql`
        DELETE FROM community_posts WHERE organization_id = ${organizationId} RETURNING file_path`);
      for (const r of [...dm, ...posts]) if (r.file_path) files.push(r.file_path);
      await q(sql`DELETE FROM notifications WHERE organization_id = ${organizationId}`);
      await q(sql`DELETE FROM activity_log WHERE organization_id = ${organizationId}`);
      await q(sql`DELETE FROM audit_log WHERE organization_id = ${organizationId}`);
      await q(sql`DELETE FROM email_outbox WHERE organization_id = ${organizationId}`);
      await q(sql`DELETE FROM data_requests WHERE organization_id = ${organizationId}`);
      await q(sql`UPDATE organizations SET data_deleted_at = now(), is_active = 0,
                         contact_name = NULL, contact_email = NULL
                   WHERE id = ${organizationId}`);
    });
    return { files };
  }
}
