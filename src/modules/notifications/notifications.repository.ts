import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

export interface NotificationRow {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  subject_type: string | null;
  subject_id: number | null;
  actor_name: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NewNotification {
  organizationId: number;
  userId: number;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  subjectType?: string | null;
  subjectId?: number | null;
  actorName?: string | null;
}

/**
 * Every notification read and write.
 *
 * Raw SQL throughout, deliberately — the whole file speaks snake_case, so
 * there is no casing seam of the kind §10.10 records seven times.
 */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * ONE multi-row INSERT however many recipients there are (§7.1).
   *
   * This is the hot path for fan-out: assigning a course to a department is
   * forty notifications, and forty round trips on an admin's Save is exactly
   * the N+1 the rules exist to prevent.
   */
  async insert(entries: NewNotification[]): Promise<void> {
    if (entries.length === 0) return;

    const values = entries.map(
      (e) => sql`(${e.organizationId}, ${e.userId}, ${e.type}, ${e.title},
                  ${e.body ?? null}, ${e.link ?? null}, ${e.subjectType ?? null},
                  ${e.subjectId ?? null}, ${e.actorName ?? null})`,
    );

    await this.db.run(sql`
      INSERT INTO notifications
        (organization_id, user_id, type, title, body, link,
         subject_type, subject_id, actor_name)
      VALUES ${sql.join(values, sql`, `)}
    `);
  }

  /**
   * This person's notifications, newest first. Paginated (§7.6) — the table
   * grows with every assignment and completion.
   *
   * Scoped by `user_id`, which is stricter than an org scope: one person's
   * own rows, never their colleagues'. The org column is still there for
   * cleanup and reporting, but it is not what confines this read.
   */
  async list(userId: number, limit: number, offset: number) {
    return this.db.all<NotificationRow>(sql`
      SELECT id, type, title, body, link, subject_type, subject_id,
             actor_name, read_at, created_at
        FROM notifications
       WHERE user_id = ${userId}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${offset}
    `);
  }

  /** The badge. Served by the partial index on unread rows. */
  async unreadCount(userId: number): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM notifications
       WHERE user_id = ${userId} AND read_at IS NULL
    `);
    return Number(rows[0]?.n ?? 0);
  }

  async total(userId: number): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = ${userId}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Mark every unread row read. `read_at IS NULL` in the predicate is not
   * redundant: without it this rewrites the whole history on every open and
   * moves timestamps that already meant something.
   */
  async markAllRead(userId: number): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE notifications
         SET read_at = now()
       WHERE user_id = ${userId} AND read_at IS NULL
      RETURNING id
    `);
    return rows.length;
  }

  /** Mark one read. `user_id` is in the predicate, so it can only be theirs. */
  async markRead(userId: number, id: number): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE notifications
         SET read_at = now()
       WHERE id = ${id} AND user_id = ${userId} AND read_at IS NULL
      RETURNING id
    `);
    return rows.length;
  }

  /**
   * Has this person already been told this exact thing recently?
   *
   * The completion triggers (lesson complete, assessment submitted, SCORM
   * commit) fire constantly and re-evaluate the same state each time, so a
   * notification derived from that state — "you are 2nd on the leaderboard" —
   * would be sent on every lesson a learner finishes. Badges do not need this
   * because `awardMany` is ON CONFLICT DO NOTHING and only ever reports
   * genuinely new ones; a rank has no such row to conflict against.
   */
  async existsRecent(input: {
    userId: number;
    type: string;
    subjectId: number | null;
    withinDays: number;
  }): Promise<boolean> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM notifications
       WHERE user_id = ${input.userId}
         AND type = ${input.type}
         AND subject_id IS NOT DISTINCT FROM ${input.subjectId}
         AND created_at > now() - (${input.withinDays} || ' days')::interval
       LIMIT 1
    `);
    return rows.length > 0;
  }

  /* ── Recipient lookups, for fan-out ── */

  /**
   * Active admin-portal accounts in an organization.
   *
   * `r.portal = 'admin'` rather than `users.role`, the same discriminator the
   * tenant directory uses — a trainer's role sits on the trainer portal and
   * must not receive "a learner was onboarded".
   */
  async adminRecipients(organizationId: number): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT u.id
        FROM users u
        JOIN roles r ON r.id = u.role_id
       WHERE u.organization_id = ${organizationId}
         AND u.is_active = 1
         AND r.portal = 'admin'
    `);
    return rows.map((r) => Number(r.id));
  }

  /**
   * Active admins of the PLATFORM org — Edstellar's own staff — and that
   * org's id, which the caller needs for the notification's own
   * `organization_id`.
   *
   * Resolved HERE from `organizations.is_platform` rather than taken as an
   * argument, so `NotificationsModule` stays dependency-free (its whole point
   * — every module imports it, so it can import none of them). The
   * alternative was making every caller inject `OrganizationsService` just to
   * ask for a number.
   */
  async platformRecipients(): Promise<{
    organizationId: number | null;
    userIds: number[];
  }> {
    const rows = await this.db.all<{ organization_id: number; id: number }>(sql`
      SELECT o.id AS organization_id, u.id
        FROM organizations o
        JOIN users u ON u.organization_id = o.id AND u.is_active = 1
        JOIN roles r ON r.id = u.role_id AND r.portal = 'admin'
       WHERE o.is_platform
    `);
    return {
      organizationId: rows[0] ? Number(rows[0].organization_id) : null,
      userIds: rows.map((r) => Number(r.id)),
    };
  }

  /** Everyone currently on a session's roster. */
  async sessionRosterRecipients(sessionId: number): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT u.id
        FROM session_roster sr
        JOIN users u ON u.id = sr.user_id
       WHERE sr.session_id = ${sessionId} AND u.is_active = 1
    `);
    return rows.map((r) => Number(r.id));
  }
}
