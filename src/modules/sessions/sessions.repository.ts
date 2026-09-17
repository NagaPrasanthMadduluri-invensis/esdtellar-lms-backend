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
  async setCancelled(scope: OrgScope, ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE sessions s
         SET status = 'cancelled'
       WHERE s.id IN ${idList(ids)} AND ${orgScope('s', scope)}
         AND s.status <> 'completed'
      RETURNING s.id
    `);
    return rows.length;
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
      start_time: string | null;
      end_time: string | null;
      capacity: number | null;
      trainer_user_id: number | null;
      trainer_name: string | null;
      status: string;
      roster_count: number;
    }>(sql`
      SELECT b.id, b.session_id, b.batch_no, b.label, b.date, b.start_time,
             b.end_time, b.capacity, b.trainer_user_id, b.status,
             CASE WHEN u.id IS NULL THEN NULL
                  ELSE u.first_name || ' ' || u.last_name END AS trainer_name,
             (SELECT COUNT(*) FROM session_roster sr
               WHERE sr.batch_id = b.id) AS roster_count
        FROM session_batches b
        LEFT JOIN users u ON u.id = b.trainer_user_id
       WHERE b.session_id IN ${idList(sessionIds)} AND ${orgScope('b', scope)}
       ORDER BY b.session_id, b.batch_no
    `);
  }

  async findBatch(scope: OrgScope, batchId: number) {
    const rows = await this.db.all<{ id: number; session_id: number; batch_no: number }>(sql`
      SELECT b.id, b.session_id, b.batch_no FROM session_batches b
       WHERE b.id = ${batchId} AND ${orgScope('b', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** The next batch number for a session. Stored, never derived from a count. */
  async nextBatchNo(scope: OrgScope, sessionId: number): Promise<number> {
    const rows = await this.db.all<{ n: number | null }>(sql`
      SELECT MAX(b.batch_no) AS n FROM session_batches b
       WHERE b.session_id = ${sessionId} AND ${orgScope('b', scope)}
    `);
    return Number(rows[0]?.n ?? 0) + 1;
  }

  async createBatch(input: {
    organizationId: number;
    sessionId: number;
    batchNo: number;
    label: string | null;
    date: string | null;
    startTime: string | null;
    endTime: string | null;
    capacity: number | null;
    trainerUserId: number | null;
  }) {
    const [created] = await this.db
      .insert(sessionBatches)
      .values({
        organizationId: input.organizationId,
        sessionId: input.sessionId,
        batchNo: input.batchNo,
        label: input.label,
        date: input.date,
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
    }>(sql`
      SELECT w.id, w.user_id, u.first_name, u.last_name, u.email,
             u.department, w.created_at
        FROM session_waitlist w
        JOIN users u ON u.id = w.user_id
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
     tenant, it does not replace it. */

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
      WHERE ${orgScope('s', scope)} AND s.trainer_user_id = ${trainerUserId}
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
        AND s.trainer_user_id = ${trainerUserId}
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

  async findWithCourse(scope: OrgScope, sessionId: number) {
    const rows = await this.db.all(sql`
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

  async deleteSession(scope: OrgScope, sessionId: number): Promise<void> {
    await this.db
      .delete(sessions)
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.organizationId, scope.organizationId),
        ),
      );
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
  async addToRoster(
    scope: OrgScope,
    sessionId: number,
    userId: number,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO session_roster (organization_id, session_id, user_id)
      SELECT u.organization_id, ${sessionId}, u.id
      FROM users u
      WHERE u.id = ${userId} AND u.role = 'learner' AND ${orgScope('u', scope)}
      ON CONFLICT (session_id, user_id) DO NOTHING
    `);
  }

  /**
   * Bulk department enrolment as ONE statement. The legacy handler selected the
   * matching learners and then inserted them one at a time in a loop.
   */
  async enrollDepartment(
    scope: OrgScope,
    sessionId: number,
    department: string,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO session_roster (organization_id, session_id, user_id)
      SELECT u.organization_id, ${sessionId}, u.id FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1
        AND u.department = ${department}
        AND ${orgScope('u', scope)}
        AND u.id NOT IN (
          SELECT user_id FROM session_roster WHERE session_id = ${sessionId}
        )
      ON CONFLICT (session_id, user_id) DO NOTHING
    `);
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
             LEAST(now(), (s.date::date + s.end_time::time)::timestamptz)
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

  /* ── Learner ── */

  async listForLearner(scope: OrgScope, userId: number) {
    return this.db.all(sql`
      SELECT s.id, s.title, s.session_type, s.department, s.date,
             s.start_time, s.end_time, s.trainer, s.venue_url,
             s.description, s.status, s.capacity,
             c.name AS course_name,
             tc.id AS training_course_id,
             sa.status AS attendance_status
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
}
