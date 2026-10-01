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
  /**
   * Returns the new ids IN THE ORDER THE ENTRIES WERE GIVEN, so the caller
   * can pair each one with its recipient. Postgres does not promise
   * `RETURNING` order matches `VALUES` order in general, but for a single
   * multi-row INSERT with no conflict clause it does in practice — and the
   * pairing here is only used to stamp `email_outbox.notification_id`, which
   * is forensic (0037). Nothing depends on it being right.
   */
  async insert(entries: NewNotification[]): Promise<number[]> {
    if (entries.length === 0) return [];

    const values = entries.map(
      (e) => sql`(${e.organizationId}, ${e.userId}, ${e.type}, ${e.title},
                  ${e.body ?? null}, ${e.link ?? null}, ${e.subjectType ?? null},
                  ${e.subjectId ?? null}, ${e.actorName ?? null})`,
    );

    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO notifications
        (organization_id, user_id, type, title, body, link,
         subject_type, subject_id, actor_name)
      VALUES ${sql.join(values, sql`, `)}
      RETURNING id
    `);
    return rows.map((r) => Number(r.id));
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

  /**
   * Active learner-portal accounts in an organization who are NOT already
   * assigned this course — the audience for "a course is open to join"
   * (0035).
   *
   * The NOT EXISTS is the whole point. Telling somebody a course is newly
   * available when it has been sitting in their My Courses for a month is
   * exactly the kind of notification that teaches people to stop reading the
   * bell, and §10.18 already pays for that lesson with `exceptUserId`.
   *
   * `r.portal = 'learner'` rather than `users.role`, the same discriminator
   * `adminRecipients` uses above — and it is what correctly INCLUDES a
   * manager, who rides in the learner portal and takes courses like anybody
   * else, while excluding trainers.
   */
  async learnerRecipientsWithoutCourse(
    organizationId: number,
    courseId: number,
  ): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT u.id
        FROM users u
        JOIN roles r ON r.id = u.role_id
       WHERE u.organization_id = ${organizationId}
         AND u.is_active = 1
         AND r.portal = 'learner'
         AND NOT EXISTS (
           SELECT 1 FROM user_course_assignments uca
            WHERE uca.user_id = u.id AND uca.course_id = ${courseId}
         )
    `);
    return rows.map((r) => Number(r.id));
  }

  /**
   * The same audience for a SESSION: active learners not already on its
   * roster and not already queuing on its waitlist.
   *
   * Both exclusions are needed. Somebody on the waitlist has already acted on
   * this session and is waiting on a seat; re-inviting them to book it would
   * read as the seat having come free, which is a promise this notification
   * cannot keep.
   */
  async learnerRecipientsNotOnSession(
    organizationId: number,
    sessionId: number,
  ): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT u.id
        FROM users u
        JOIN roles r ON r.id = u.role_id
       WHERE u.organization_id = ${organizationId}
         AND u.is_active = 1
         AND r.portal = 'learner'
         AND NOT EXISTS (
           SELECT 1 FROM session_roster sr
            WHERE sr.user_id = u.id AND sr.session_id = ${sessionId}
         )
         AND NOT EXISTS (
           SELECT 1 FROM session_waitlist sw
            WHERE sw.user_id = u.id AND sw.session_id = ${sessionId}
         )
    `);
    return rows.map((r) => Number(r.id));
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
