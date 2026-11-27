import { Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import { sessionBatches, sessionRoster, sessions } from '@/database/schema';

/**
 * `id IN (...)` as a real list.
 *
 * Drizzle expands a JS array into a ROW constructor, which Postgres reads as
 * `IN ((1,2,3))` and rejects with "cannot cast type record to integer". Same
 * idiom as `CoursesRepository.idList` and `JourneysRepository.idList` — the
 * third copy, and the point at which it is worth remembering that all three
 * exist for one Drizzle quirk.
 */
function idList(ids: number[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

export interface AttendanceRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  department: string | null;
  status: string | null;
  join_time: string | null;
  notes: string | null;
  is_locked: number | null;
  marked_by: number | null;
  marker_first: string | null;
  marker_last: string | null;
}

/**
 * What `findWithCourse` returns.
 *
 * The query is `SELECT s.*`, so the named fields below are the ones callers
 * actually read rather than a complete list of the row — hence the index
 * signature. It was previously untyped (`db.all` with no parameter, which
 * infers `{}`), so every property access on it was a compile error waiting
 * for the first caller to try one. Naming the columns the service depends on
 * is the difference between that and a typo being caught.
 */
export interface SessionWithCourseRow {
  id: number;
  title: string;
  status: string;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  venue: string | null;
  trainer: string | null;
  course_name: string | null;
  training_course_id: number | null;
  thumbnail_url: string | null;
  /** The rest of `s.*`, not enumerated. */
  [key: string]: unknown;
}

@Injectable()
export class SessionsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async list(scope: OrgScope, archived = false) {
    // Archived and live are never mixed — the toggle swaps between two sets,
    // the same rule Course Library (§10.12) and Learning Paths follow.
    const archiveFilter = archived
      ? sql`AND s.archived_at IS NOT NULL`
      : sql`AND s.archived_at IS NULL`;
    return this.db.all(sql`
      SELECT s.*, c.name AS course_name,
        tc.id AS training_course_id,
        -- A session's picture IS its training course's picture (§10.7):
        -- the learner's card for a session is that course.
        tc.thumbnail_url AS thumbnail_url,
        (SELECT COUNT(*) FROM session_roster sr
         WHERE sr.session_id = s.id) AS roster_count,
        (SELECT COUNT(*) FROM session_attendance sa
         WHERE sa.session_id = s.id AND sa.status IS NOT NULL) AS marked_count,
        (SELECT COUNT(*) FROM session_attendance sa
         WHERE sa.session_id = s.id
           AND sa.status IN ('present', 'late', 'partial')) AS credited_count
      FROM sessions s
      LEFT JOIN courses c ON c.id = s.course_id
      LEFT JOIN courses tc ON tc.session_id = s.id
      WHERE ${orgScope('s', scope)} ${archiveFilter}
      ORDER BY s.date DESC, s.start_time DESC
    `);
  }

  /** How many archived sessions this org has — the toggle's badge. */
  async archivedCount(scope: OrgScope): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM sessions s
      WHERE ${orgScope('s', scope)} AND s.archived_at IS NOT NULL
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Bulk archive / restore. Sessions are org-OWNED, never shared, so
   * `orgScope` is both the tenancy guard and the whole predicate — unlike
   * courses and paths, there is no platform-owned session to exclude.
   */
  async setArchived(
    scope: OrgScope,
    ids: number[],
    archived: boolean,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE sessions s
         SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE s.id IN ${idList(ids)} AND ${orgScope('s', scope)}
      RETURNING s.id
    `);
    return rows.length;
  }

  /**
   * Bulk cancel.
   *
   * Refused for a session already marked `completed`: cancelling one would
   * contradict the attendance already credited against it, and those
   * completions are real learning history (§10.7). The count reports how many
   * were actually cancelled rather than erroring on the first that was not.
   */
  /**
   * Returns the ids that MOVED into cancelled. An already-cancelled session is
   * excluded by the predicate, so a second bulk cancel neither counts it as
   * affected nor tells its roster a second time.
   */
  async setCancelled(scope: OrgScope, ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE sessions s
         SET status = 'cancelled'
       WHERE s.id IN ${idList(ids)} AND ${orgScope('s', scope)}
         AND s.status NOT IN ('completed', 'cancelled')
      RETURNING s.id
    `);
    return rows.map((r) => Number(r.id));
  }

  /* ── Batches ───────────────────────────────────────────────────────────
     A batch is a scheduling subdivision of ONE session's roster, never a
     separate course — read `0025_session_batches.sql` before changing any of
     this. Batches are optional: a session with none is a single sitting using
     its own date, time and capacity. */

  /** Every batch of every session in one query — the list needs them per card. */
  async listBatchesForSessions(scope: OrgScope, sessionIds: number[]) {
    if (sessionIds.length === 0) return [];
    return this.db.all<{
      id: number;
      session_id: number;
      batch_no: number;
      label: string | null;
      date: string | null;
      end_date: string | null;
      start_time: string | null;
      end_time: string | null;
      capacity: number | null;
      trainer_user_id: number | null;
      trainer_name: string | null;
      status: string;
      session_date_id: number | null;
      roster_count: number;
      waitlist_count: number;
    }>(sql`
      SELECT b.id, b.session_id, b.batch_no, b.label, b.date, b.end_date, b.start_time,
             b.end_time, b.capacity, b.trainer_user_id, b.status, b.session_date_id,
             CASE WHEN u.id IS NULL THEN NULL
                  ELSE u.first_name || ' ' || u.last_name END AS trainer_name,
             -- People placed in this batch on its date (0076).
             (SELECT COUNT(*)::int FROM session_batch_members m
               WHERE m.batch_id = b.id) AS roster_count,
             (SELECT COUNT(*)::int FROM session_waitlist w
               WHERE w.batch_id = b.id) AS waitlist_count
        FROM session_batches b
        LEFT JOIN users u ON u.id = b.trainer_user_id
       WHERE b.session_id IN ${idList(sessionIds)} AND ${orgScope('b', scope)}
       ORDER BY b.session_id, b.date NULLS LAST, b.batch_no
    `);
  }

  async findBatch(scope: OrgScope, batchId: number) {
    const rows = await this.db.all<{
      id: number;
      session_id: number;
      batch_no: number;
      label: string | null;
      date: string | null;
      end_date: string | null;
      capacity: number | null;
      status: string;
      session_date_id: number | null;
    }>(sql`
      SELECT b.id, b.session_id, b.batch_no, b.label, b.date, b.end_date,
             b.capacity, b.status, b.session_date_id
        FROM session_batches b
       WHERE b.id = ${batchId} AND ${orgScope('b', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** The next batch number on one date (0076). Stored, never derived from a count. */
  async nextBatchNo(scope: OrgScope, sessionDateId: number): Promise<number> {
    const rows = await this.db.all<{ n: number | null }>(sql`
      SELECT MAX(b.batch_no) AS n FROM session_batches b
       WHERE b.session_date_id = ${sessionDateId} AND ${orgScope('b', scope)}
    `);
    return Number(rows[0]?.n ?? 0) + 1;
  }

  async createBatch(input: {
    organizationId: number;
    sessionId: number;
    batchNo: number;
    label: string | null;
    date: string | null;
    endDate: string | null;
    startTime: string | null;
    endTime: string | null;
    capacity: number | null;
    trainerUserId: number | null;
    sessionDateId: number;
  }) {
    const [created] = await this.db
      .insert(sessionBatches)
      .values({
        organizationId: input.organizationId,
        sessionId: input.sessionId,
        sessionDateId: input.sessionDateId,
        batchNo: input.batchNo,
        label: input.label,
        date: input.date,
        endDate: input.endDate,
        startTime: input.startTime,
        endTime: input.endTime,
        capacity: input.capacity,
        trainerUserId: input.trainerUserId,
      })
      .returning();
    return created;
  }

  async updateBatch(
    scope: OrgScope,
    batchId: number,
    input: {
      label: string | null;
      date: string | null;
      endDate: string | null;
      startTime: string | null;
      endTime: string | null;
      capacity: number | null;
      trainerUserId: number | null;
      status: string;
    },
  ) {
    const [updated] = await this.db
      .update(sessionBatches)
      .set({
        label: input.label,
        date: input.date,
        endDate: input.endDate,
        startTime: input.startTime,
        endTime: input.endTime,
        capacity: input.capacity,
        trainerUserId: input.trainerUserId,
        status: input.status,
      })
      .where(
        and(
          eq(sessionBatches.id, batchId),
          eq(sessionBatches.organizationId, scope.organizationId),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /**
   * Delete a batch. The roster rows pointing at it fall back to NULL by the
   * FK's ON DELETE SET NULL — those people stay enrolled on the session and
   * the admin re-assigns them to another sitting.
   */
  async deleteBatch(scope: OrgScope, batchId: number): Promise<void> {
    await this.db
      .delete(sessionBatches)
      .where(
        and(
          eq(sessionBatches.id, batchId),
          eq(sessionBatches.organizationId, scope.organizationId),
        ),
      );
  }

  /** Move one rostered learner into a batch (or out of one, with null). */
  async setRosterBatch(
    scope: OrgScope,
    sessionId: number,
    userId: number,
    batchId: number | null,
  ): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE session_roster sr
         SET batch_id = ${batchId}
       WHERE sr.session_id = ${sessionId} AND sr.user_id = ${userId}
         AND ${orgScope('sr', scope)}
      RETURNING sr.id
    `);
    return rows.length;
  }

  /* ── Waitlist ──────────────────────────────────────────────────────────
     Only self-enrol sessions produce one. A waitlisted person is NOT
     enrolled — no course assignment, not in the roster count, not creditable
     by attendance. See the migration for why this is its own table. */

  async waitlistCounts(scope: OrgScope, sessionIds: number[]) {
    if (sessionIds.length === 0) return [];
    return this.db.all<{ session_id: number; n: number }>(sql`
      SELECT w.session_id, COUNT(*)::int AS n
        FROM session_waitlist w
       WHERE w.session_id IN ${idList(sessionIds)} AND ${orgScope('w', scope)}
       GROUP BY w.session_id
    `);
  }

  /** The queue for one session, oldest first — position is arrival order. */
  async listWaitlist(scope: OrgScope, sessionId: number) {
    return this.db.all<{
      id: number;
      user_id: number;
      first_name: string;
      last_name: string;
      email: string;
      department: string | null;
      created_at: string;
      batch_id: number | null;
      batch_no: number | null;
    }>(sql`
      SELECT w.id, w.user_id, u.first_name, u.last_name, u.email,
             u.department, w.created_at, w.batch_id, b.batch_no
        FROM session_waitlist w
        JOIN users u ON u.id = w.user_id
        LEFT JOIN session_batches b ON b.id = w.batch_id
       WHERE w.session_id = ${sessionId} AND ${orgScope('w', scope)}
       ORDER BY w.created_at
    `);
  }

  async removeFromWaitlist(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      DELETE FROM session_waitlist w
       WHERE w.session_id = ${sessionId} AND w.user_id = ${userId}
         AND ${orgScope('w', scope)}
      RETURNING w.id
    `);
    return rows.length;
  }

  /* ── Trainer portal (specs/rbac.md §3.6.1) ─────────────────────────────
     Two methods, and both carry `trainer_user_id = ${trainerUserId}` in the
     SQL rather than checking it afterwards in the service. That is deliberate:
     a trainer must not be able to learn that another trainer's session exists,
     so a session that is not his has to be indistinguishable from one that
     does not exist. Filtering in the query makes the 404 fall out naturally.

     `orgScope` is still applied on top — the trainer axis narrows within the
     tenant, it does not replace it.

     Both match `session_batches.trainer_user_id` as well as the session's own
     column. A batch carries its own trainer (0025), so a trainer given one
     sitting of a multi-batch session matched neither method before this and
     saw an empty portal while holding real work. `trainerOwns` states the
     rule once so the list and the ownership probe cannot disagree — if they
     did, a session would appear in the list and 404 when opened. */

  /** Assigned to the session, or to any of its sittings. */
  private trainerOwns(trainerUserId: number) {
    return sql`(
      s.trainer_user_id = ${trainerUserId}
      OR EXISTS (
        SELECT 1 FROM session_batches b
         WHERE b.session_id = s.id AND b.trainer_user_id = ${trainerUserId}
      )
    )`;
  }

  async listForTrainer(scope: OrgScope, trainerUserId: number) {
    return this.db.all(sql`
      SELECT s.*, c.name AS course_name,
        tc.id AS training_course_id,
        -- A session's picture IS its training course's picture (§10.7):
        -- the learner's card for a session is that course.
        tc.thumbnail_url AS thumbnail_url,
        (SELECT COUNT(*) FROM session_roster sr
         WHERE sr.session_id = s.id) AS roster_count,
        (SELECT COUNT(*) FROM session_attendance sa
         WHERE sa.session_id = s.id AND sa.status IS NOT NULL) AS marked_count,
        (SELECT COUNT(*) FROM session_attendance sa
         WHERE sa.session_id = s.id
           AND sa.status IN ('present', 'late', 'partial')) AS credited_count
      FROM sessions s
      LEFT JOIN courses c ON c.id = s.course_id
      LEFT JOIN courses tc ON tc.session_id = s.id
      WHERE ${orgScope('s', scope)} AND ${this.trainerOwns(trainerUserId)}
      ORDER BY s.date DESC, s.start_time DESC
    `);
  }

  /** The ownership probe every trainer endpoint starts with. Null = not his. */
  async findTrainerSession(
    scope: OrgScope,
    sessionId: number,
    trainerUserId: number,
  ) {
    const rows = await this.db.all(sql`
      SELECT s.*, c.name AS course_name, tc.id AS training_course_id,
        tc.thumbnail_url AS thumbnail_url
      FROM sessions s
      LEFT JOIN courses c ON c.id = s.course_id
      LEFT JOIN courses tc ON tc.session_id = s.id
      WHERE s.id = ${sessionId}
        AND ${orgScope('s', scope)}
        AND ${this.trainerOwns(trainerUserId)}
    `);
    return rows[0] ?? null;
  }

  /** Trainers whose sessions the admin session form can assign. */
  async listTrainers(scope: OrgScope) {
    return this.db.all<{ id: number; first_name: string; last_name: string }>(sql`
      SELECT u.id, u.first_name, u.last_name
      FROM users u
      WHERE ${orgScope('u', scope)} AND u.role = 'trainer' AND u.is_active = 1
      ORDER BY u.first_name, u.last_name
    `);
  }

  async findWithCourse(
    scope: OrgScope,
    sessionId: number,
  ): Promise<SessionWithCourseRow | null> {
    const rows = await this.db.all<SessionWithCourseRow>(sql`
      SELECT s.*, c.name AS course_name, tc.id AS training_course_id,
        tc.thumbnail_url AS thumbnail_url
      FROM sessions s
      LEFT JOIN courses c ON c.id = s.course_id
      LEFT JOIN courses tc ON tc.session_id = s.id
      WHERE s.id = ${sessionId} AND ${orgScope('s', scope)}
    `);
    return rows[0] ?? null;
  }

  /** Status and schedule only — what the completion rules need, nothing more. */
  async findStatus(scope: OrgScope, sessionId: number) {
    const rows = await this.db.all<{
      id: number;
      status: string;
      date: string;
      start_time: string;
      end_time: string;
    }>(sql`
      SELECT id, status, date, start_time, end_time
      FROM sessions WHERE id = ${sessionId} AND ${orgScope('sessions', scope)}
    `);
    return rows[0] ?? null;
  }

  /** `sessions` is content — it always takes the creating admin's org (§3.3). */
  async createSession(
    scope: OrgScope,
    values: Omit<typeof sessions.$inferInsert, 'organizationId'>,
  ): Promise<number> {
    const [created] = await this.db
      .insert(sessions)
      .values({ ...values, organizationId: scope.organizationId })
      .returning({ id: sessions.id });
    return created.id;
  }

  async updateSession(
    scope: OrgScope,
    sessionId: number,
    values: Partial<typeof sessions.$inferInsert>,
  ): Promise<void> {
    await this.db
      .update(sessions)
      .set(values)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.organizationId, scope.organizationId),
        ),
      );
  }

  /** True when a row of THIS org was deleted; false for a foreign or unknown id. */
  async deleteSession(scope: OrgScope, sessionId: number): Promise<boolean> {
    const rows = await this.db
      .delete(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.organizationId, scope.organizationId),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length > 0;
  }

  /* ── Roster ──
     Every method below takes `sessionId` as an already-untrusted route param.
     Each re-anchors on `sessions s` filtered by `scope` (rather than trusting a
     prior check elsewhere), and additionally restricts learners to the same
     org — a session cannot roster a learner from another tenant. */

  async enrolled(scope: OrgScope, sessionId: number) {
    return this.db.all(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department
      FROM session_roster sr
      JOIN sessions s ON s.id = sr.session_id
      JOIN users u ON u.id = sr.user_id
      WHERE sr.session_id = ${sessionId} AND u.role = 'learner'
        AND ${orgScope('s', scope)}
      ORDER BY u.first_name
    `);
  }

  async available(scope: OrgScope, sessionId: number) {
    return this.db.all(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department
      FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1
        AND ${orgScope('u', scope)}
        AND u.id NOT IN (
          SELECT user_id FROM session_roster WHERE session_id = ${sessionId}
        )
        AND EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.id = ${sessionId} AND ${orgScope('s', scope)}
        )
      ORDER BY u.first_name
    `);
  }

  /**
   * `session_roster` is activity — the row takes the enrolled LEARNER's own
   * org, read from `users` rather than assumed to equal `scope`. Restricting
   * the SELECT to `${orgScope('u', scope)}` means a learner from another org
   * can never be added, so in practice the two coincide — but the value
   * written is always the learner's own.
   */
  /**
   * Returns the user ids ACTUALLY inserted — empty when the person was
   * already on the roster, or is not a learner in this org.
   *
   * `RETURNING` past an `ON CONFLICT DO NOTHING` yields only real inserts,
   * which is what lets the service notify exactly who joined. Before that it
   * notified the whole roster on every add, because the ids in the request
   * were the only thing it had and the department path carries none at all —
   * tolerable while an admin added people one at a time, and not once
   * learners could add themselves (0035): twenty self-enrolments would have
   * sent the first person nineteen notifications.
   */
  async addToRoster(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<number[]> {
    const rows = await this.db.all<{ user_id: number }>(sql`
      INSERT INTO session_roster (organization_id, session_id, user_id)
      SELECT u.organization_id, ${sessionId}, u.id
      FROM users u
      WHERE u.id = ${userId} AND u.role = 'learner' AND ${orgScope('u', scope)}
      ON CONFLICT (session_id, user_id) DO NOTHING
      RETURNING user_id
    `);
    return rows.map((r) => Number(r.user_id));
  }

  /**
   * Bulk department enrolment as ONE statement. The legacy handler selected the
   * matching learners and then inserted them one at a time in a loop.
   */
  async enrollDepartment(
    scope: OrgScope,
    sessionId: number,
    department: string,
  ): Promise<number[]> {
    const rows = await this.db.all<{ user_id: number }>(sql`
      INSERT INTO session_roster (organization_id, session_id, user_id)
      SELECT u.organization_id, ${sessionId}, u.id FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1
        AND u.department = ${department}
        AND ${orgScope('u', scope)}
        AND u.id NOT IN (
          SELECT user_id FROM session_roster WHERE session_id = ${sessionId}
        )
      ON CONFLICT (session_id, user_id) DO NOTHING
      RETURNING user_id
    `);
    return rows.map((r) => Number(r.user_id));
  }

  /* ── Self-enrolment (0035) ── */

  /**
   * How full a session is, counting the roster rather than a stored number.
   *
   * A stored count is a second definition of the same fact, free to drift the
   * first time an admin removes somebody — the reason `display_status` is
   * derived too (§10.7).
   */
  async rosterCount(scope: OrgScope, sessionId: number): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM session_roster sr
       WHERE sr.session_id = ${sessionId} AND ${orgScope('sr', scope)}
    `);
    return rows[0]?.n ?? 0;
  }

  /**
   * Put somebody in the queue. Returns their 1-based position, or null when
   * they were already queuing — position is by arrival, so the queue needs no
   * rank column and the count of earlier rows IS the position.
   */
  async addToWaitlist(
    scope: OrgScope,
    sessionId: number,
    userId: number,
    batchId: number | null = null,
  ): Promise<number | null> {
    const inserted = await this.db.all<{ id: number }>(sql`
      INSERT INTO session_waitlist (organization_id, session_id, user_id, batch_id)
      VALUES (${scope.organizationId}, ${sessionId}, ${userId}, ${batchId})
      ON CONFLICT (session_id, user_id) DO NOTHING
      RETURNING id
    `);
    if (inserted.length === 0) return null;
    return this.waitlistPosition(scope, sessionId, userId);
  }

  async waitlistPosition(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<number | null> {
    // Position within the same queue: the batch they wait for, or the
    // session-wide queue when they wait for no particular batch.
    const rows = await this.db.all<{ position: number }>(sql`
      SELECT COUNT(*)::int + 1 AS position
        FROM session_waitlist w
        JOIN session_waitlist m
          ON m.session_id = ${sessionId} AND m.user_id = ${userId}
       WHERE w.session_id = ${sessionId}
         AND ${orgScope('w', scope)}
         AND w.batch_id IS NOT DISTINCT FROM m.batch_id
         AND w.created_at < m.created_at
    `);
    return rows[0] ? Number(rows[0].position) : null;
  }

  /**
   * This learner's attendance status for a session, or null when nobody has
   * marked them. The marker of the line a self-leave may not cross.
   */
  async attendanceFor(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<string | null> {
    const rows = await this.db.all<{ status: string | null }>(sql`
      SELECT sa.status FROM session_attendance sa
       WHERE sa.session_id = ${sessionId} AND sa.user_id = ${userId}
         AND ${orgScope('sa', scope)}
       LIMIT 1
    `);
    return rows[0]?.status ?? null;
  }

  /** Is this learner already on the roster of this session? */
  async isOnRoster(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM session_roster sr
       WHERE sr.session_id = ${sessionId} AND sr.user_id = ${userId}
         AND ${orgScope('sr', scope)}
    `);
    return (rows[0]?.n ?? 0) > 0;
  }

  async removeFromRoster(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<void> {
    await this.db
      .delete(sessionRoster)
      .where(
        and(
          eq(sessionRoster.sessionId, sessionId),
          eq(sessionRoster.userId, userId),
          eq(sessionRoster.organizationId, scope.organizationId),
        ),
      );
  }

  /* ── Attendance ── */

  async attendance(scope: OrgScope, sessionId: number): Promise<AttendanceRow[]> {
    return this.db.all<AttendanceRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department,
             sa.status, sa.join_time, sa.notes, sa.is_locked, sa.marked_by,
             mu.first_name AS marker_first, mu.last_name AS marker_last
      FROM session_roster sr
      JOIN sessions s ON s.id = sr.session_id
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN session_attendance sa
        ON sa.session_id = sr.session_id AND sa.user_id = sr.user_id
      LEFT JOIN users mu ON mu.id = sa.marked_by
      WHERE sr.session_id = ${sessionId} AND ${orgScope('s', scope)}
      ORDER BY u.first_name
    `);
  }

  /**
   * `session_attendance` is activity — the row takes the attending LEARNER's
   * own org, read from `users` the same way `addToRoster` does. The
   * `SELECT ... FROM users u WHERE u.id = ... AND scope` shape means marking
   * attendance for a user outside `scope` silently inserts nothing for that
   * record, rather than crediting a stranger's org.
   */
  async upsertAttendance(
    scope: OrgScope,
    sessionId: number,
    adminId: number,
    isLocked: number,
    records: {
      user_id: number;
      status?: string | null;
      join_time?: string | null;
      notes?: string | null;
    }[],
  ): Promise<void> {
    if (records.length === 0) return;

    // One statement for the whole roster. This was a loop with an `await`
    // inside — one round trip per learner, so a 200-person roster cost 200
    // (§7.1).
    //
    // Built as a parameterised VALUES list via sql.join, NOT as
    // `${array}::int[]`: Drizzle binds a JS array as a scalar, so the array
    // form fails with `malformed array literal`. Every value here is still a
    // bound parameter — nothing is interpolated as text.
    //
    // The org is taken from each learner's OWN row via the join, never from
    // the caller, and the join is org-scoped — so a learner outside this
    // organization simply produces no row rather than an error or a
    // cross-tenant write.
    const values = sql.join(
      records.map(
        (r) =>
          sql`(${r.user_id}::int, ${r.status ?? null}::text, ${r.join_time ?? null}::text, ${r.notes ?? null}::text)`,
      ),
      sql`, `,
    );

    await this.db.run(sql`
      INSERT INTO session_attendance
        (organization_id, session_id, user_id, status, join_time, notes,
         marked_by, is_locked, marked_at)
      SELECT u.organization_id, ${sessionId}, v.user_id,
             v.status, v.join_time, v.notes,
             ${adminId}, ${isLocked}, now()
      FROM (VALUES ${values}) AS v(user_id, status, join_time, notes)
      JOIN users u ON u.id = v.user_id AND ${orgScope('u', scope)}
      ON CONFLICT(session_id, user_id) DO UPDATE SET
        status    = excluded.status,
        join_time = excluded.join_time,
        notes     = excluded.notes,
        marked_by = excluded.marked_by,
        is_locked = excluded.is_locked,
        marked_at = excluded.marked_at
    `);
  }

  /* ── Training course ───────────────────────────────────────────────────
     A session's companion course: one course, one module, one lesson of
     content_type 'session'. Everything downstream (My Courses, progress,
     learning hours, dashboards, certificates) reads courses/assignments/
     completions, so keeping this in step is the whole integration.

     The training (course + module + lesson) is CONTENT and takes the
     SESSION's own org — `scope` here, since every caller has already
     resolved the session within its own scope.
  ────────────────────────────────────────────────────────────────────────── */

  /** The session lesson's ids, or null when the training was never built. */
  /**
   * Does this course exist and belong to this organization? Used to turn a
   * body-supplied `course_id` into a 404 instead of a foreign-key violation
   * surfacing as a 500.
   *
   * Strict scope, not contentScope: a session links to a course a tenant
   * OWNS. A platform-owned global course is shared read-only content and has
   * no single owning session.
   */
  async findCourseInScope(scope: OrgScope, courseId: number) {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT c.id FROM courses c
      WHERE c.id = ${courseId} AND ${orgScope('c', scope)}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async findTraining(scope: OrgScope, sessionId: number) {
    const rows = await this.db.all<{
      course_id: number;
      module_id: number;
      lesson_id: number;
    }>(sql`
      SELECT c.id AS course_id, cm.id AS module_id, l.id AS lesson_id
      FROM courses c
      JOIN course_modules cm ON cm.course_id = c.id
      JOIN lessons l ON l.module_id = cm.id AND l.content_type = 'session'
      WHERE c.session_id = ${sessionId} AND ${contentScope('c', scope)}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Builds the course, its module and its session lesson.
   *
   * `ON CONFLICT (session_id)` makes this safe to call twice — two admins
   * saving the same new session cannot produce two trainings, because
   * courses_session_unique refuses the second.
   */
  async createTraining(
    scope: OrgScope,
    sessionId: number,
    values: {
      name: string;
      description: string | null;
      isActive: number;
      lessonTitle: string;
      contentUrl: string;
      durationMinutes: number;
    },
  ): Promise<void> {
    await this.db.run(sql`
      WITH new_course AS (
        INSERT INTO courses (organization_id, name, description, is_active, session_id)
        VALUES (${scope.organizationId}, ${values.name}, ${values.description},
                ${values.isActive}, ${sessionId})
        ON CONFLICT (session_id) DO NOTHING
        RETURNING id
      ), new_module AS (
        INSERT INTO course_modules (organization_id, course_id, title, sort_order, is_active)
        SELECT ${scope.organizationId}, id, 'Live session', 0, 1 FROM new_course
        -- course_id is carried out so the lesson below can set its own; a
        -- lesson has belonged to a course directly since migration 0020, and
        -- the column is NOT NULL.
        RETURNING id, course_id
      )
      INSERT INTO lessons (organization_id, course_id, module_id, title, description,
                           content_type, content_url, duration_minutes, sort_order,
                           is_preview, is_active)
      SELECT ${scope.organizationId}, course_id, id, ${values.lessonTitle},
             ${values.description}, 'session',
             ${values.contentUrl}, ${values.durationMinutes}, 0, 0, 1
      FROM new_module
    `);
  }

  /**
   * The picture currently on this session's training course, if any.
   *
   * Read before a write so a replaced file can be deleted, and before a delete
   * for the same reason — the cascade takes the row, not the bytes on disk.
   */
  async findTrainingThumbnail(scope: OrgScope, sessionId: number) {
    const rows = await this.db.all<{ thumbnail_url: string | null }>(sql`
      SELECT c.thumbnail_url
      FROM courses c
      WHERE c.session_id = ${sessionId} AND ${orgScope('c', scope)}
      LIMIT 1
    `);
    return rows[0]?.thumbnail_url ?? null;
  }

  /**
   * Sets the training course's picture.
   *
   * Its own statement rather than another column on `updateTraining`, because
   * the two have different rules: name, description and active state are
   * rewritten from the session on every save, while the picture is only
   * touched when the admin actually changed it (§10.10).
   */
  async setTrainingThumbnail(
    scope: OrgScope,
    sessionId: number,
    thumbnailUrl: string | null,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE courses SET thumbnail_url = ${thumbnailUrl}, updated_at = now()
      WHERE session_id = ${sessionId} AND ${orgScope('courses', scope)}
    `);
  }

  /** Keeps the training in step after the session is edited. */
  async updateTraining(
    scope: OrgScope,
    sessionId: number,
    values: {
      name: string;
      description: string | null;
      isActive: number;
      lessonTitle: string;
      contentUrl: string;
      durationMinutes: number;
    },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE courses SET
        name = ${values.name},
        description = ${values.description},
        is_active = ${values.isActive},
        updated_at = now()
      WHERE session_id = ${sessionId} AND ${orgScope('courses', scope)}
    `);

    await this.db.run(sql`
      UPDATE lessons SET
        title = ${values.lessonTitle},
        description = ${values.description},
        content_url = ${values.contentUrl},
        duration_minutes = ${values.durationMinutes}
      WHERE content_type = 'session'
        AND module_id IN (
          SELECT cm.id FROM course_modules cm
          JOIN courses c ON c.id = cm.course_id
          WHERE c.session_id = ${sessionId} AND ${orgScope('c', scope)}
        )
    `);
  }

  /**
   * Roster membership becomes a course assignment — the whole roster in one
   * statement, so adding a department of 200 learners is still a single round
   * trip. Idempotent, so it can follow any roster change.
   *
   * `user_course_assignments` is activity — it takes the roster row's own org
   * (`sr.organization_id`, the learner's), not `scope`.
   */
  async assignRosterToTraining(
    scope: OrgScope,
    sessionId: number,
    adminId: number,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_course_assignments
        (organization_id, user_id, course_id, assigned_by, due_date)
      SELECT sr.organization_id, sr.user_id, c.id, ${adminId}, s.date
      FROM session_roster sr
      JOIN sessions s ON s.id = sr.session_id
      JOIN courses c ON c.session_id = sr.session_id
      WHERE sr.session_id = ${sessionId} AND ${orgScope('s', scope)}
      ON CONFLICT (user_id, course_id) DO NOTHING
    `);
  }

  /** Leaving the roster withdraws the training and any credit for it. */
  async unassignFromTraining(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<void> {
    await this.db.run(sql`
      DELETE FROM user_lesson_completions ulc
      USING lessons l, course_modules cm, courses c
      WHERE ulc.lesson_id = l.id
        AND l.module_id = cm.id
        AND cm.course_id = c.id
        AND c.session_id = ${sessionId}
        AND l.content_type = 'session'
        AND ulc.user_id = ${userId}
        AND ${orgScope('c', scope)}
    `);

    await this.db.run(sql`
      DELETE FROM user_course_assignments uca
      USING courses c
      WHERE uca.course_id = c.id
        AND c.session_id = ${sessionId}
        AND uca.user_id = ${userId}
        AND ${orgScope('c', scope)}
    `);
  }

  /** Learners the attendance record credits: present, late or partial. */
  async attendanceTally(scope: OrgScope, sessionId: number) {
    const rows = await this.db.all<{ marked: number; credited: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE sa.status IS NOT NULL) AS marked,
        COUNT(*) FILTER (
          WHERE sa.status IN ('present', 'late', 'partial')
        ) AS credited
      FROM session_attendance sa
      JOIN sessions s ON s.id = sa.session_id
      WHERE sa.session_id = ${sessionId} AND ${orgScope('s', scope)}
    `);
    return {
      marked: Number(rows[0]?.marked ?? 0),
      credited: Number(rows[0]?.credited ?? 0),
    };
  }

  /**
   * Brings lesson completions in line with the attendance record.
   *
   * Two statements rather than one so an attendance correction after the fact
   * is honoured in both directions: a learner switched to `present` gains the
   * training credit and its hours, and one switched to `absent` loses them.
   * `completed_at` is the session's own end time, not now(), so the hours land
   * in the month the training actually happened — capped at now() so marking a
   * future-dated session complete cannot post hours into the future.
   *
   * `user_lesson_completions` is activity — it takes the attendance row's own
   * org (`sa.organization_id`, the learner's).
   */
  async syncCompletions(scope: OrgScope, sessionId: number): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_lesson_completions (organization_id, user_id, lesson_id, completed_at)
      SELECT sa.organization_id, sa.user_id, l.id,
             LEAST(now(), (COALESCE(s.end_date, s.date)::date + s.end_time::time)::timestamptz)
      FROM session_attendance sa
      JOIN sessions s ON s.id = sa.session_id
      JOIN courses c ON c.session_id = s.id
      JOIN course_modules cm ON cm.course_id = c.id
      JOIN lessons l ON l.module_id = cm.id AND l.content_type = 'session'
      WHERE sa.session_id = ${sessionId}
        AND sa.status IN ('present', 'late', 'partial')
        AND ${orgScope('s', scope)}
      ON CONFLICT (user_id, lesson_id) DO NOTHING
    `);

    await this.db.run(sql`
      DELETE FROM user_lesson_completions ulc
      USING lessons l, course_modules cm, courses c
      WHERE ulc.lesson_id = l.id
        AND l.module_id = cm.id
        AND cm.course_id = c.id
        AND c.session_id = ${sessionId}
        AND l.content_type = 'session'
        AND ${orgScope('c', scope)}
        AND NOT EXISTS (
          SELECT 1 FROM session_attendance sa
          WHERE sa.session_id = ${sessionId}
            AND sa.user_id = ulc.user_id
            AND sa.status IN ('present', 'late', 'partial')
        )
    `);
  }

  /** Reopening a completed session withdraws every learner's credit. */
  async clearCompletions(scope: OrgScope, sessionId: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM user_lesson_completions ulc
      USING lessons l, course_modules cm, courses c
      WHERE ulc.lesson_id = l.id
        AND l.module_id = cm.id
        AND cm.course_id = c.id
        AND c.session_id = ${sessionId}
        AND l.content_type = 'session'
        AND ${orgScope('c', scope)}
    `);
  }

  /* ── Feedback and the session report (0074) ─────────────────────────── */

  /**
   * Every learner's feedback on one session, newest first, with who they are
   * and which batch they sat in. ACTIVITY, so orgScope on the feedback row.
   */
  async feedbackForSession(scope: OrgScope, sessionId: number) {
    return this.db.all<{
      id: number;
      user_id: number;
      name: string;
      email: string;
      department: string | null;
      job_role: string | null;
      batches: string | null;
      rating_content: number;
      rating_trainer: number;
      rating_delivery: number;
      comment: string | null;
      created_at: string;
    }>(sql`
      SELECT f.id, u.id AS user_id,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name,
             u.email, u.department, u.job_role,
             (SELECT string_agg(
                'Batch ' || bb.batch_no || COALESCE(' · ' || bb.label, '') || ' (' || to_char(sd.date::date, 'FMDD Mon') || ')',
                ', ' ORDER BY sd.date)
                FROM session_batch_members m
                JOIN session_batches bb ON bb.id = m.batch_id
                JOIN session_dates sd ON sd.id = m.session_date_id
               WHERE m.session_id = f.session_id AND m.user_id = f.user_id) AS batches,
             f.rating_content, f.rating_trainer, f.rating_delivery,
             f.comment, f.created_at
        FROM session_feedback f
        JOIN users u ON u.id = f.user_id
       WHERE f.session_id = ${sessionId} AND ${orgScope('f', scope)}
       ORDER BY f.created_at DESC
    `);
  }

  /**
   * One row per person on the roster for the report: who, which batch, when
   * they joined the roster, their attendance and their feedback. One query.
   */
  async reportLearners(scope: OrgScope, sessionId: number) {
    return this.db.all<{
      user_id: number;
      name: string;
      email: string;
      department: string | null;
      job_role: string | null;
      batches: string | null;
      enrolled_at: string | null;
      attendance: string | null;
      join_time: string | null;
      notes: string | null;
      rating_content: number | null;
      rating_trainer: number | null;
      rating_delivery: number | null;
      comment: string | null;
      feedback_at: string | null;
    }>(sql`
      SELECT u.id AS user_id,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS name,
             u.email, u.department, u.job_role,
             (SELECT string_agg(
                'Batch ' || bb.batch_no || COALESCE(' · ' || bb.label, '') || ' (' || to_char(sd.date::date, 'FMDD Mon') || ')',
                ', ' ORDER BY sd.date)
                FROM session_batch_members m
                JOIN session_batches bb ON bb.id = m.batch_id
                JOIN session_dates sd ON sd.id = m.session_date_id
               WHERE m.session_id = sr.session_id AND m.user_id = sr.user_id) AS batches, sr.enrolled_at,
             sa.status AS attendance, sa.join_time, sa.notes,
             f.rating_content, f.rating_trainer, f.rating_delivery, f.comment,
             f.created_at AS feedback_at
        FROM session_roster sr
        JOIN users u ON u.id = sr.user_id
   LEFT JOIN session_attendance sa ON sa.session_id = sr.session_id AND sa.user_id = sr.user_id
   LEFT JOIN session_feedback f ON f.session_id = sr.session_id AND f.user_id = sr.user_id
       WHERE sr.session_id = ${sessionId} AND ${orgScope('sr', scope)}
       ORDER BY u.first_name, u.last_name
    `);
  }

  /* ── Seats (0074) ────────────────────────────────────────────────────── */

  /** People currently placed in one batch (on its date, 0076). */
  async batchRosterCount(scope: OrgScope, batchId: number): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM session_batch_members m
       WHERE m.batch_id = ${batchId} AND ${orgScope('m', scope)}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /** Whether this person is already placed in this batch. */
  async isInBatch(scope: OrgScope, batchId: number, userId: number): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM session_batch_members m
       WHERE m.batch_id = ${batchId} AND m.user_id = ${userId} AND ${orgScope('m', scope)}
    `);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /** The waitlisted batch for one person, or null (session queue / not queued). */
  async waitlistEntry(scope: OrgScope, sessionId: number, userId: number) {
    const rows = await this.db.all<{ batch_id: number | null }>(sql`
      SELECT w.batch_id FROM session_waitlist w
       WHERE w.session_id = ${sessionId} AND w.user_id = ${userId}
         AND ${orgScope('w', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Run `fn` while holding a per-session lock, so two people cannot both take
   * the last seat. The count-then-insert inside `fn` is serialised against
   * every other booking or move on the same session; the lock is released
   * when this transaction ends, after `fn`'s own writes have committed.
   */
  async withSeatLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7401, ${sessionId})`);
      return fn();
    });
  }

  /* ── Learner ── */

  async listForLearner(scope: OrgScope, userId: number) {
    return this.db.all(sql`
      SELECT s.id, s.title, s.session_type, s.department, s.date, s.end_date,
             s.start_time, s.end_time, s.trainer, s.venue_url,
             s.description, s.status, s.capacity,
             -- The learner's batch on the first date they are placed (0076)
             -- the full per-date list is attached by the service.
             (SELECT m.batch_id FROM session_batch_members m
                JOIN session_dates sd ON sd.id = m.session_date_id
               WHERE m.session_id = s.id AND m.user_id = sr.user_id
               ORDER BY sd.date LIMIT 1) AS my_batch_id,
             (SELECT COUNT(*)::int FROM session_roster r2
               WHERE r2.session_id = s.id) AS roster_count,
             c.name AS course_name,
             tc.id AS training_course_id,
             -- A session's picture IS its companion training course's (§10.10),
             -- so the card has art without a second column or a new upload.
             tc.thumbnail_url AS thumbnail_url,
             sa.status AS attendance_status,
             -- Has this learner already rated it? The card offers "Give
             -- feedback" only where the API would accept one, so the control
             -- is absent rather than refused (§10.3.1.2, §10.20).
             (SELECT f.id FROM session_feedback f
               WHERE f.session_id = s.id AND f.user_id = sr.user_id)
               AS feedback_id
      FROM session_roster sr
      JOIN sessions s ON s.id = sr.session_id
      LEFT JOIN courses c ON c.id = s.course_id
      LEFT JOIN courses tc ON tc.session_id = s.id
      LEFT JOIN session_attendance sa
        ON sa.session_id = sr.session_id AND sa.user_id = sr.user_id
      WHERE sr.user_id = ${userId} AND ${orgScope('s', scope)}
      ORDER BY s.date ASC, s.start_time ASC
    `);
  }

  /* ── Session dates, day batches, placements, day attendance (0076) ─────
     BACKEND_STRUCTURE 10.67. A session runs on a set of dates; each date has
     one or more batches; a rostered learner is placed in one batch on each
     date; attendance is marked per date and rolled up into
     session_attendance, which crediting, certificates and reports read. */

  async listDatesForSessions(scope: OrgScope, sessionIds: number[]) {
    if (sessionIds.length === 0) return [];
    return this.db.all<SessionDateRow>(sql`
      SELECT sd.id, sd.session_id, sd.date, sd.original_date, sd.previous_date,
             sd.change, sd.changed_at
        FROM session_dates sd
       WHERE sd.session_id IN ${idList(sessionIds)} AND ${orgScope('sd', scope)}
       ORDER BY sd.session_id, sd.date
    `);
  }

  async findDate(scope: OrgScope, dateId: number) {
    const rows = await this.db.all<SessionDateRow>(sql`
      SELECT sd.id, sd.session_id, sd.date, sd.original_date, sd.previous_date,
             sd.change, sd.changed_at
        FROM session_dates sd
       WHERE sd.id = ${dateId} AND ${orgScope('sd', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** New dates for a session. Returns the rows actually created. */
  async insertDates(scope: OrgScope, sessionId: number, dates: string[]) {
    if (dates.length === 0) return [];
    const values = sql.join(dates.map((d) => sql`(${scope.organizationId}::int, ${sessionId}::int, ${d}::text, ${d}::text)`), sql`, `);
    return this.db.all<{ id: number; date: string }>(sql`
      INSERT INTO session_dates (organization_id, session_id, date, original_date)
      SELECT v.org, v.sid, v.d, v.o FROM (VALUES ${values}) AS v(org, sid, d, o)
      WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = ${sessionId} AND ${orgScope('s', scope)})
      ON CONFLICT (session_id, date) DO NOTHING
      RETURNING id, date
    `);
  }

  /**
   * Move one date, keeping its row so its batches, placements and attendance
   * go with it. Its batches' own `date` follows. Two statements in one
   * transaction so a batch can never disagree with its date.
   */
  async moveDate(scope: OrgScope, dateId: number, to: string, change: string | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE session_dates sd
           SET previous_date = sd.date, date = ${to}, change = ${change}, changed_at = now()
         WHERE sd.id = ${dateId} AND ${orgScope('sd', scope)}
      `);
      await tx.execute(sql`
        UPDATE session_batches b SET date = ${to}
         WHERE b.session_date_id = ${dateId} AND ${orgScope('b', scope)}
      `);
    });
  }

  async deleteDate(scope: OrgScope, dateId: number): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM session_dates sd WHERE sd.id = ${dateId} AND ${orgScope('sd', scope)}
    `);
  }

  /** How many people have attendance marked on one date. */
  async markedOnDate(scope: OrgScope, dateId: number): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM session_day_attendance d
       WHERE d.session_date_id = ${dateId} AND d.status IS NOT NULL AND ${orgScope('d', scope)}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /** The session row's summary: first date, and last date when there are several. */
  async syncSessionSummary(scope: OrgScope, sessionId: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE sessions s
         SET date = r.first_date,
             end_date = CASE WHEN r.last_date = r.first_date THEN NULL ELSE r.last_date END
        FROM (
          SELECT MIN(sd.date) AS first_date, MAX(sd.date) AS last_date
            FROM session_dates sd WHERE sd.session_id = ${sessionId}
        ) r
       WHERE s.id = ${sessionId} AND ${orgScope('s', scope)} AND r.first_date IS NOT NULL
    `);
  }

  /**
   * One batch per slot on each new date. A slot with no times or capacity
   * follows the session's (NULL falls back in `buildSittings`). One statement.
   */
  async createBatchesForDates(
    scope: OrgScope,
    sessionId: number,
    dates: { id: number; date: string }[],
    slots: { label: string | null; start_time: string | null; end_time: string | null; capacity: number | null; trainer_user_id?: number | null }[],
  ): Promise<void> {
    if (dates.length === 0 || slots.length === 0) return;
    const rows = dates.flatMap((d) =>
      slots.map((slot, i) =>
        sql`(${d.id}::int, ${d.date}::text, ${i + 1}::int, ${slot.label}::text, ${slot.start_time}::text, ${slot.end_time}::text, ${slot.capacity}::int, ${slot.trainer_user_id ?? null}::int)`,
      ),
    );
    await this.db.execute(sql`
      INSERT INTO session_batches
        (organization_id, session_id, session_date_id, date, batch_no, label,
         start_time, end_time, capacity, trainer_user_id, status)
      SELECT ${scope.organizationId}, ${sessionId}, v.did, v.d, v.no, v.label,
             v.st, v.et, v.cap, v.tr, 'scheduled'
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(did, d, no, label, st, et, cap, tr)
      ON CONFLICT (session_date_id, batch_no) DO NOTHING
    `);
  }

  /** The batches on one date, as slots, to copy onto a new date. */
  async slotsOfDate(scope: OrgScope, dateId: number) {
    return this.db.all<{ label: string | null; start_time: string | null; end_time: string | null; capacity: number | null; trainer_user_id: number | null }>(sql`
      SELECT b.label, b.start_time, b.end_time, b.capacity, b.trainer_user_id
        FROM session_batches b
       WHERE b.session_date_id = ${dateId} AND ${orgScope('b', scope)}
       ORDER BY b.batch_no
    `);
  }

  async batchCountOnDate(scope: OrgScope, dateId: number): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM session_batches b
       WHERE b.session_date_id = ${dateId} AND ${orgScope('b', scope)}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Place everyone on the roster on every date that has exactly one batch,
   * where they are not placed yet. A date with a choice of batches is left
   * for the admin or the learner to choose. One statement, idempotent, run
   * after anything that changes the roster, the dates or the batches.
   */
  async autoPlace(scope: OrgScope, sessionId: number): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO session_batch_members (organization_id, session_id, session_date_id, batch_id, user_id)
      SELECT sr.organization_id, sr.session_id, b.session_date_id, b.id, sr.user_id
        FROM session_roster sr
        JOIN session_batches b ON b.session_id = sr.session_id AND b.session_date_id IS NOT NULL
       WHERE sr.session_id = ${sessionId} AND ${orgScope('sr', scope)}
         AND b.status <> 'cancelled'
         AND (SELECT COUNT(*) FROM session_batches b2
               WHERE b2.session_date_id = b.session_date_id AND b2.status <> 'cancelled') = 1
      ON CONFLICT (session_date_id, user_id) DO NOTHING
    `);
  }

  /** Put one learner in a batch on that batch's date, replacing any other batch that day. */
  async placeMember(scope: OrgScope, sessionId: number, batchId: number, userId: number): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO session_batch_members (organization_id, session_id, session_date_id, batch_id, user_id)
      SELECT sr.organization_id, sr.session_id, b.session_date_id, b.id, sr.user_id
        FROM session_roster sr
        JOIN session_batches b ON b.id = ${batchId} AND b.session_id = sr.session_id
       WHERE sr.session_id = ${sessionId} AND sr.user_id = ${userId}
         AND b.session_date_id IS NOT NULL AND ${orgScope('sr', scope)}
      ON CONFLICT (session_date_id, user_id) DO UPDATE SET batch_id = excluded.batch_id
      RETURNING id
    `);
    return rows.length;
  }

  async unplaceMember(scope: OrgScope, sessionId: number, dateId: number, userId: number): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      DELETE FROM session_batch_members m
       WHERE m.session_id = ${sessionId} AND m.session_date_id = ${dateId}
         AND m.user_id = ${userId} AND ${orgScope('m', scope)}
      RETURNING m.id
    `);
    return rows.length;
  }

  /** Leaving the roster leaves every batch. */
  async removeMembers(scope: OrgScope, sessionId: number, userId: number): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM session_batch_members m
       WHERE m.session_id = ${sessionId} AND m.user_id = ${userId} AND ${orgScope('m', scope)}
    `);
  }

  /** Who is in which batch on which date, for a set of sessions. */
  async membersFor(scope: OrgScope, sessionIds: number[], userId?: number) {
    if (sessionIds.length === 0) return [];
    return this.db.all<{ session_id: number; session_date_id: number; batch_id: number; user_id: number }>(sql`
      SELECT m.session_id, m.session_date_id, m.batch_id, m.user_id
        FROM session_batch_members m
       WHERE m.session_id IN ${idList(sessionIds)} AND ${orgScope('m', scope)}
         ${userId === undefined ? sql`` : sql`AND m.user_id = ${userId}`}
    `);
  }

  /** Per-date attendance rows for one session. */
  async dayAttendance(scope: OrgScope, sessionId: number) {
    return this.db.all<{ user_id: number; session_date_id: number; status: string | null; join_time: string | null; notes: string | null; is_locked: number }>(sql`
      SELECT d.user_id, d.session_date_id, d.status, d.join_time, d.notes, d.is_locked
        FROM session_day_attendance d
       WHERE d.session_id = ${sessionId} AND ${orgScope('d', scope)}
    `);
  }

  /**
   * Mark attendance on one or more dates in one statement. Each row takes the
   * LEARNER's own org from `users`, scoped, the same way `upsertAttendance`
   * does, so a stranger produces no row.
   */
  async upsertDayAttendance(
    scope: OrgScope,
    sessionId: number,
    dateIds: number[],
    markedBy: number,
    isLocked: number,
    records: { user_id: number; status?: string | null; join_time?: string | null; notes?: string | null }[],
  ): Promise<void> {
    if (records.length === 0 || dateIds.length === 0) return;
    const values = sql.join(
      records.map((r) => sql`(${r.user_id}::int, ${r.status ?? null}::text, ${r.join_time ?? null}::text, ${r.notes ?? null}::text)`),
      sql`, `,
    );
    await this.db.execute(sql`
      INSERT INTO session_day_attendance
        (organization_id, session_id, session_date_id, user_id, status, join_time,
         notes, marked_by, is_locked, marked_at)
      SELECT u.organization_id, ${sessionId}, sd.id, v.user_id, v.status, v.join_time,
             v.notes, ${markedBy}, ${isLocked}, now()
        FROM (VALUES ${values}) AS v(user_id, status, join_time, notes)
        JOIN users u ON u.id = v.user_id AND ${orgScope('u', scope)}
        JOIN session_dates sd ON sd.session_id = ${sessionId} AND sd.id IN ${idList(dateIds)}
      ON CONFLICT (session_date_id, user_id) DO UPDATE SET
        status = excluded.status, join_time = excluded.join_time, notes = excluded.notes,
        marked_by = excluded.marked_by, is_locked = excluded.is_locked, marked_at = excluded.marked_at
    `);
  }

  /**
   * Roll each learner's per-date attendance up into `session_attendance`:
   *   no date marked           -> unmarked (NULL)
   *   every marked date excused -> excused
   *   no date attended          -> absent
   *   present on every date     -> present
   *   present or late on every  -> late
   *   otherwise                 -> partial (attended some, not all)
   * A one-date session therefore keeps exactly the status marked that day.
   */
  async rollUpAttendance(scope: OrgScope, sessionId: number): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO session_attendance
        (organization_id, session_id, user_id, status, join_time, notes, marked_by, is_locked, marked_at)
      SELECT d.organization_id, d.session_id, d.user_id,
             CASE
               WHEN COUNT(*) FILTER (WHERE d.status IS NOT NULL) = 0 THEN NULL
               WHEN COUNT(*) FILTER (WHERE d.status IS NOT NULL) = COUNT(*) FILTER (WHERE d.status = 'excused') THEN 'excused'
               WHEN COUNT(*) FILTER (WHERE d.status IN ('present', 'late', 'partial')) = 0 THEN 'absent'
               WHEN COUNT(*) FILTER (WHERE d.status = 'present') >= n.total THEN 'present'
               WHEN COUNT(*) FILTER (WHERE d.status IN ('present', 'late')) >= n.total THEN 'late'
               ELSE 'partial'
             END,
             (array_agg(d.join_time ORDER BY sd.date) FILTER (WHERE COALESCE(d.join_time, '') <> ''))[1],
             string_agg(NULLIF(d.notes, ''), ' | ' ORDER BY sd.date),
             (array_agg(d.marked_by ORDER BY d.marked_at DESC))[1],
             MAX(d.is_locked), MAX(d.marked_at)
        FROM session_day_attendance d
        JOIN session_dates sd ON sd.id = d.session_date_id
        CROSS JOIN (SELECT COUNT(*)::int AS total FROM session_dates WHERE session_id = ${sessionId}) n
       WHERE d.session_id = ${sessionId} AND ${orgScope('d', scope)}
       GROUP BY d.organization_id, d.session_id, d.user_id, n.total
      ON CONFLICT (session_id, user_id) DO UPDATE SET
        status = excluded.status, join_time = excluded.join_time, notes = excluded.notes,
        marked_by = excluded.marked_by, is_locked = excluded.is_locked, marked_at = excluded.marked_at
    `);
  }

  /** The session lesson's length, after its dates change. */
  async setTrainingDuration(scope: OrgScope, sessionId: number, minutes: number): Promise<void> {
    await this.db.execute(sql`
      UPDATE lessons SET duration_minutes = ${minutes}
       WHERE content_type = 'session'
         AND module_id IN (
           SELECT cm.id FROM course_modules cm
             JOIN courses c ON c.id = cm.course_id
            WHERE c.session_id = ${sessionId} AND ${orgScope('c', scope)}
         )
    `);
  }

  /** Everyone told about a schedule change: the roster and every trainer on it. */
  async scheduleAudience(scope: OrgScope, sessionId: number) {
    const rows = await this.db.all<{ user_id: number; kind: string }>(sql`
      SELECT sr.user_id, 'learner' AS kind FROM session_roster sr
       WHERE sr.session_id = ${sessionId} AND ${orgScope('sr', scope)}
      UNION
      SELECT s.trainer_user_id, 'trainer' FROM sessions s
       WHERE s.id = ${sessionId} AND s.trainer_user_id IS NOT NULL AND ${orgScope('s', scope)}
      UNION
      SELECT b.trainer_user_id, 'trainer' FROM session_batches b
       WHERE b.session_id = ${sessionId} AND b.trainer_user_id IS NOT NULL AND ${orgScope('b', scope)}
    `);
    return {
      learners: rows.filter((r) => r.kind === 'learner').map((r) => Number(r.user_id)),
      trainers: [...new Set(rows.filter((r) => r.kind === 'trainer').map((r) => Number(r.user_id)))],
    };
  }
}

export interface SessionDateRow {
  id: number;
  session_id: number;
  date: string;
  original_date: string;
  previous_date: string | null;
  change: string | null;
  changed_at: string | null;
}
