import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

/**
 * `id IN ${idList(ids)}`, because Drizzle expands a bare JS array into a ROW
 * constructor — `IN ((1,2,3))` — which Postgres rejects, and `ANY(${ids})`
 * fails the same way with "malformed array literal". The fourth copy of this
 * helper in the codebase (courses, journeys, sessions); §10.15 already said
 * it should be lifted into `database/` when a fourth appeared, and this is
 * that fourth. Left here to keep this change to one concern.
 */
function idList(ids: number[]): SQL {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::int`),
    sql`, `,
  )})`;
}

/**
 * Everything the email module reads or writes.
 *
 * Raw SQL throughout, deliberately — the whole file speaks snake_case, so
 * there is no casing seam of the kind §10.10 records seven separate times.
 * Do not mix a Drizzle `.select()` in here.
 */

/** One recipient, resolved by the gate query. */
export interface RecipientRow {
  user_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  org_name: string | null;
  org_logo_url: string | null;
  facts: string | null;
  subject_name: string | null;
  org_announcements: number;
  all_off: number;
  groups_off: string;
  suppressed: number;
}

export interface NewOutboxRow {
  organizationId: number;
  userId: number;
  notificationId: number | null;
  type: string;
  policy: string;
  toEmail: string;
  toName: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  facts: string | null;
  subjectName: string | null;
  subject: string;
  body: string | null;
  link: string | null;
  actorName: string | null;
  dedupeKey: string;
}

/** An outbox row as the worker reads it. */
export interface OutboxRow {
  id: number;
  organizationId: number;
  userId: number;
  type: string;
  policy: string;
  toEmail: string;
  toName: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  facts: string | null;
  subjectName: string | null;
  subject: string;
  body: string | null;
  link: string | null;
  actorName: string | null;
  attempts: number;
}

interface RawOutboxRow {
  id: string | number;
  organization_id: number;
  user_id: number;
  type: string;
  policy: string;
  to_email: string;
  to_name: string | null;
  org_name: string | null;
  org_logo_url: string | null;
  facts: string | null;
  subject_name: string | null;
  subject: string;
  body: string | null;
  link: string | null;
  actor_name: string | null;
  attempts: number;
}

@Injectable()
export class EmailOutboxRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Everything the gate needs about every recipient, in ONE round trip.
   *
   * A 500-learner fan-out resolves in one query rather than 500, matching
   * the single-statement rule the notifications repository already keeps
   * (§7.1). The LEFT JOINs matter: a user with no preferences row and an
   * address with no suppression row are both the common case, and an INNER
   * JOIN would silently drop exactly the people who should be emailed.
   */
  async recipients(userIds: number[]): Promise<RecipientRow[]> {
    if (userIds.length === 0) return [];
    return this.db.all<RecipientRow>(sql`
      SELECT u.id                             AS user_id,
             LOWER(u.email)                   AS email,
             u.first_name,
             u.last_name,
             o.name                           AS org_name,
             o.logo_url                       AS org_logo_url,
             COALESCE(o.email_announcements, 0) AS org_announcements,
             COALESCE(p.all_off, 0)           AS all_off,
             COALESCE(p.groups_off, '')       AS groups_off,
             CASE WHEN s.email IS NULL THEN 0 ELSE 1 END AS suppressed
        FROM users u
        JOIN organizations o          ON o.id = u.organization_id
        LEFT JOIN user_email_preferences p ON p.user_id = u.id
        LEFT JOIN email_suppressions s     ON s.email = LOWER(u.email)
       WHERE u.id IN ${idList(userIds)}
         AND u.is_active = 1
         AND o.is_active = 1
         AND u.email IS NOT NULL
         AND u.email <> ''
    `);
  }

  /**
   * ONE multi-row INSERT however many recipients (§7.1).
   *
   * `ON CONFLICT (dedupe_key) DO NOTHING` is what makes a double-clicked
   * Save harmless. Returns the count actually written, so the caller can
   * log the difference rather than assume.
   */
  async enqueue(rows: NewOutboxRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const values = rows.map(
      (r) => sql`(${r.organizationId}, ${r.userId}, ${r.notificationId},
                  ${r.type}, ${r.policy}, ${r.toEmail}, ${r.toName},
                  ${r.orgName}, ${r.orgLogoUrl}, ${r.subject}, ${r.body},
                  ${r.link}, ${r.actorName}, ${r.facts}, ${r.subjectName},
                  ${r.dedupeKey})`,
    );

    const inserted = await this.db.all<{ id: string }>(sql`
      INSERT INTO email_outbox
        (organization_id, user_id, notification_id, type, policy,
         to_email, to_name, org_name, org_logo_url, subject, body, link,
         actor_name, facts, subject_name, dedupe_key)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `);
    return inserted.length;
  }

  /**
   * Writes rows straight to `suppressed` — used only by the allowlist.
   *
   * Opting out does NOT write a row (that would be 500 rows of nothing per
   * fan-out). The allowlist does, because the whole purpose of a dry run is
   * to count what WOULD have been sent.
   */
  async enqueueSuppressed(rows: NewOutboxRow[], reason: string): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map(
      (r) => sql`(${r.organizationId}, ${r.userId}, ${r.notificationId},
                  ${r.type}, ${r.policy}, ${r.toEmail}, ${r.toName},
                  ${r.orgName}, ${r.orgLogoUrl}, ${r.subject}, ${r.body},
                  ${r.link}, ${r.actorName}, ${r.facts}, ${r.subjectName},
                  ${r.dedupeKey}, 'suppressed', ${reason})`,
    );
    const inserted = await this.db.all<{ id: string }>(sql`
      INSERT INTO email_outbox
        (organization_id, user_id, notification_id, type, policy,
         to_email, to_name, org_name, org_logo_url, subject, body, link,
         actor_name, facts, subject_name, dedupe_key, status, last_error)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `);
    return inserted.length;
  }

  /* ─────────────────── the worker's side ─────────────────── */

  /**
   * Returns rows orphaned by a hard kill to the queue.
   *
   * `attempts` was already incremented when they were claimed, which is the
   * property that stops a row that crashes the worker from looping forever:
   * it gets five goes and then gives up like any other failure.
   */
  async reapStuck(olderThanMinutes: number): Promise<number> {
    const rows = await this.db.all<{ id: string }>(sql`
      UPDATE email_outbox
         SET status = 'pending', claimed_at = NULL
       WHERE status = 'sending'
         AND claimed_at < NOW() - (${olderThanMinutes} * INTERVAL '1 minute')
      RETURNING id
    `);
    return rows.length;
  }

  /**
   * Claims a batch.
   *
   * `FOR UPDATE SKIP LOCKED` is not negotiable: it is what makes a second
   * worker harmless if pm2 is ever misconfigured to run two. Without it,
   * both would claim the same rows and every recipient would get doubles.
   *
   * `attempts` increments HERE, not on failure — see `reapStuck`.
   */
  async claim(limit: number): Promise<OutboxRow[]> {
    const rows = await this.db.all<RawOutboxRow>(sql`
      UPDATE email_outbox
         SET status = 'sending', attempts = attempts + 1, claimed_at = NOW()
       WHERE id IN (
         SELECT id FROM email_outbox
          WHERE status = 'pending'
            AND next_attempt_at <= NOW()
          ORDER BY id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, organization_id, user_id, type, policy, to_email, to_name,
                org_name, org_logo_url, subject, body, link, actor_name,
                facts, subject_name, attempts
    `);
    return rows.map((r) => ({
      id: Number(r.id),
      organizationId: r.organization_id,
      userId: r.user_id,
      type: r.type,
      policy: r.policy,
      toEmail: r.to_email,
      toName: r.to_name,
      orgName: r.org_name,
      orgLogoUrl: r.org_logo_url,
      facts: r.facts,
      subjectName: r.subject_name,
      subject: r.subject,
      body: r.body,
      link: r.link,
      actorName: r.actor_name,
      attempts: r.attempts,
    }));
  }

  async markSent(id: number, providerMessageId: string): Promise<void> {
    await this.db.run(sql`
      UPDATE email_outbox
         SET status = 'sent', sent_at = NOW(), last_error = NULL,
             provider_message_id = ${providerMessageId}
       WHERE id = ${id}
    `);
  }

  async markFailed(id: number, error: string): Promise<void> {
    await this.db.run(sql`
      UPDATE email_outbox
         SET status = 'failed', last_error = ${error.slice(0, 1000)}
       WHERE id = ${id}
    `);
  }

  async markSuppressed(id: number, reason: string): Promise<void> {
    await this.db.run(sql`
      UPDATE email_outbox
         SET status = 'suppressed', last_error = ${reason.slice(0, 1000)}
       WHERE id = ${id}
    `);
  }

  /** Back to the queue after a retryable failure, with backoff. */
  async reschedule(
    id: number,
    delaySeconds: number,
    error: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE email_outbox
         SET status = 'pending', claimed_at = NULL,
             last_error = ${error.slice(0, 1000)},
             next_attempt_at = NOW() + (${delaySeconds} * INTERVAL '1 second')
       WHERE id = ${id}
    `);
  }

  /**
   * Back to the queue WITHOUT consuming an attempt — throttling only.
   *
   * Separate from `reschedule` because the two mean different things. A
   * throttle says nothing about the message; counting it would burn a good
   * row's five tries on our own pacing.
   */
  async releaseThrottled(id: number, delaySeconds: number): Promise<void> {
    await this.db.run(sql`
      UPDATE email_outbox
         SET status = 'pending', claimed_at = NULL,
             attempts = GREATEST(attempts - 1, 0),
             next_attempt_at = NOW() + (${delaySeconds} * INTERVAL '1 second')
       WHERE id = ${id}
    `);
  }

  /**
   * How many have gone out today.
   *
   * UTC day, while SES's own quota is a rolling 24 hours. They disagree at
   * the boundary and that is fine at a conservative cap — noted so nobody
   * "fixes" it into something that drifts past the real limit.
   */
  async sentToday(): Promise<number> {
    const [row] = await this.db.all<{ n: string }>(sql`
      SELECT COUNT(*) AS n FROM email_outbox
       WHERE status = 'sent'
         AND sent_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
    `);
    return Number(row?.n ?? 0);
  }

  /** Re-checked at send: a batch can sit for hours under sandbox pacing. */
  async isSuppressed(email: string): Promise<boolean> {
    const [row] = await this.db.all<{ email: string }>(sql`
      SELECT email FROM email_suppressions WHERE email = ${email.toLowerCase()}
    `);
    return Boolean(row);
  }

  async suppress(
    email: string,
    reason: string,
    detail: string | null,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO email_suppressions (email, reason, detail)
      VALUES (${email.toLowerCase()}, ${reason}, ${detail})
      ON CONFLICT (email) DO UPDATE
        SET reason = EXCLUDED.reason, detail = EXCLUDED.detail
    `);
  }

  /** Correlates an SNS event back to the row that caused it. */
  async userIdForMessage(providerMessageId: string): Promise<number | null> {
    const [row] = await this.db.all<{ user_id: number }>(sql`
      SELECT user_id FROM email_outbox
       WHERE provider_message_id = ${providerMessageId}
       LIMIT 1
    `);
    return row?.user_id ?? null;
  }

  /** Deletes finished rows. Run from the worker's nightly prune. */
  async prune(olderThanDays: number): Promise<number> {
    const rows = await this.db.all<{ id: string }>(sql`
      DELETE FROM email_outbox
       WHERE status IN ('sent', 'suppressed')
         AND enqueued_at < NOW() - (${olderThanDays} * INTERVAL '1 day')
      RETURNING id
    `);
    return rows.length;
  }

  /* ─────────────────── preferences ─────────────────── */

  async preferences(
    userId: number,
  ): Promise<{ all_off: number; groups_off: string }> {
    const [row] = await this.db.all<{ all_off: number; groups_off: string }>(sql`
      SELECT all_off, groups_off FROM user_email_preferences
       WHERE user_id = ${userId}
    `);
    return row ?? { all_off: 0, groups_off: '' };
  }

  async savePreferences(
    userId: number,
    allOff: number,
    groupsOff: string,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_email_preferences (user_id, all_off, groups_off, updated_at)
      VALUES (${userId}, ${allOff}, ${groupsOff}, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET all_off = EXCLUDED.all_off,
            groups_off = EXCLUDED.groups_off,
            updated_at = NOW()
    `);
  }

  /** The unsubscribe link's write — one group, or everything. */
  async unsubscribe(userId: number, group: string): Promise<void> {
    if (group === 'all') {
      await this.savePreferences(userId, 1, '');
      return;
    }
    const current = await this.preferences(userId);
    const groups = new Set(current.groups_off.split(',').filter(Boolean));
    groups.add(group);
    await this.savePreferences(userId, current.all_off, [...groups].join(','));
  }

  /* ─────────────────── platform read ─────────────────── */

  async listForPlatform(filters: {
    status?: string;
    limit: number;
    offset: number;
  }) {
    const where = filters.status
      ? sql`WHERE o.status = ${filters.status}`
      : sql``;
    const rows = await this.db.all(sql`
      SELECT o.id, o.type, o.policy, o.to_email, o.subject, o.status,
             o.attempts, o.last_error, o.enqueued_at, o.sent_at,
             g.name AS organization_name
        FROM email_outbox o
        JOIN organizations g ON g.id = o.organization_id
        ${where}
       ORDER BY o.id DESC
       LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
    const [total] = await this.db.all<{ n: string }>(sql`
      SELECT COUNT(*) AS n FROM email_outbox o ${where}
    `);
    return { rows, total: Number(total?.n ?? 0) };
  }

  /** Status counts over a window — the verifier and the platform screen. */
  async statusCounts(hours: number) {
    return this.db.all<{ status: string; n: string }>(sql`
      SELECT status, COUNT(*) AS n
        FROM email_outbox
       WHERE enqueued_at > NOW() - (${hours} * INTERVAL '1 hour')
       GROUP BY status
    `);
  }
}
