import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { sessionRoster, sessions } from '@/database/schema';

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

  async list() {
    return this.db.all(sql`
      SELECT s.*, c.name AS course_name,
        tc.id AS training_course_id,
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
      ORDER BY s.date DESC, s.start_time DESC
    `);
  }

  async findWithCourse(sessionId: number) {
    const rows = await this.db.all(sql`
      SELECT s.*, c.name AS course_name, tc.id AS training_course_id
      FROM sessions s
      LEFT JOIN courses c ON c.id = s.course_id
      LEFT JOIN courses tc ON tc.session_id = s.id
      WHERE s.id = ${sessionId}
    `);
    return rows[0] ?? null;
  }

  /** Status and schedule only — what the completion rules need, nothing more. */
  async findStatus(sessionId: number) {
    const rows = await this.db.all<{
      id: number;
      status: string;
      date: string;
      start_time: string;
      end_time: string;
    }>(sql`
      SELECT id, status, date, start_time, end_time
      FROM sessions WHERE id = ${sessionId}
    `);
    return rows[0] ?? null;
  }

  async createSession(values: typeof sessions.$inferInsert): Promise<number> {
    const [created] = await this.db
      .insert(sessions)
      .values(values)
      .returning({ id: sessions.id });
    return created.id;
  }

  async updateSession(
    sessionId: number,
    values: Partial<typeof sessions.$inferInsert>,
  ): Promise<void> {
    await this.db.update(sessions).set(values).where(eq(sessions.id, sessionId));
  }

  async deleteSession(sessionId: number): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, sessionId));
  }

  /* ── Roster ── */

  async enrolled(sessionId: number) {
    return this.db.all(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department
      FROM session_roster sr
      JOIN users u ON u.id = sr.user_id
      WHERE sr.session_id = ${sessionId} AND u.role = 'learner'
      ORDER BY u.first_name
    `);
  }

  async available(sessionId: number) {
    return this.db.all(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department
      FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1
        AND u.id NOT IN (
          SELECT user_id FROM session_roster WHERE session_id = ${sessionId}
        )
      ORDER BY u.first_name
    `);
  }

  async addToRoster(sessionId: number, userId: number): Promise<void> {
    await this.db
      .insert(sessionRoster)
      .values({ sessionId, userId })
      .onConflictDoNothing();
  }

  /**
   * Bulk department enrolment as ONE statement. The legacy handler selected the
   * matching learners and then inserted them one at a time in a loop.
   */
  async enrollDepartment(sessionId: number, department: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO session_roster (session_id, user_id)
      SELECT ${sessionId}, u.id FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1
        AND u.department = ${department}
        AND u.id NOT IN (
          SELECT user_id FROM session_roster WHERE session_id = ${sessionId}
        )
      ON CONFLICT (session_id, user_id) DO NOTHING
    `);
  }

  async removeFromRoster(sessionId: number, userId: number): Promise<void> {
    await this.db
      .delete(sessionRoster)
      .where(
        and(
          eq(sessionRoster.sessionId, sessionId),
          eq(sessionRoster.userId, userId),
        ),
      );
  }

  /* ── Attendance ── */

  async attendance(sessionId: number): Promise<AttendanceRow[]> {
    return this.db.all<AttendanceRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department,
             sa.status, sa.join_time, sa.notes, sa.is_locked, sa.marked_by,
             mu.first_name AS marker_first, mu.last_name AS marker_last
      FROM session_roster sr
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN session_attendance sa
        ON sa.session_id = sr.session_id AND sa.user_id = sr.user_id
      LEFT JOIN users mu ON mu.id = sa.marked_by
      WHERE sr.session_id = ${sessionId}
      ORDER BY u.first_name
    `);
  }

  async upsertAttendance(
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
    for (const record of records) {
      await this.db.run(sql`
        INSERT INTO session_attendance
          (session_id, user_id, status, join_time, notes, marked_by, is_locked, marked_at)
        VALUES (${sessionId}, ${record.user_id}, ${record.status ?? null},
                ${record.join_time ?? null}, ${record.notes ?? null},
                ${adminId}, ${isLocked}, now())
        ON CONFLICT(session_id, user_id) DO UPDATE SET
          status    = excluded.status,
          join_time = excluded.join_time,
          notes     = excluded.notes,
          marked_by = excluded.marked_by,
          is_locked = excluded.is_locked,
          marked_at = excluded.marked_at
      `);
    }
  }

  /* ── Training course ───────────────────────────────────────────────────
     A session's companion course: one course, one module, one lesson of
     content_type 'session'. Everything downstream (My Courses, progress,
     learning hours, dashboards, certificates) reads courses/assignments/
     completions, so keeping this in step is the whole integration.
  ────────────────────────────────────────────────────────────────────────── */

  /** The session lesson's ids, or null when the training was never built. */
  async findTraining(sessionId: number) {
    const rows = await this.db.all<{
      course_id: number;
      module_id: number;
      lesson_id: number;
    }>(sql`
      SELECT c.id AS course_id, cm.id AS module_id, l.id AS lesson_id
      FROM courses c
      JOIN course_modules cm ON cm.course_id = c.id
      JOIN lessons l ON l.module_id = cm.id AND l.content_type = 'session'
      WHERE c.session_id = ${sessionId}
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
        INSERT INTO courses (name, description, is_active, session_id)
        VALUES (${values.name}, ${values.description}, ${values.isActive},
                ${sessionId})
        ON CONFLICT (session_id) DO NOTHING
        RETURNING id
      ), new_module AS (
        INSERT INTO course_modules (course_id, title, sort_order, is_active)
        SELECT id, 'Live session', 0, 1 FROM new_course
        RETURNING id
      )
      INSERT INTO lessons (module_id, title, description, content_type,
                           content_url, duration_minutes, sort_order,
                           is_preview, is_active)
      SELECT id, ${values.lessonTitle}, ${values.description}, 'session',
             ${values.contentUrl}, ${values.durationMinutes}, 0, 0, 1
      FROM new_module
    `);
  }

  /** Keeps the training in step after the session is edited. */
  async updateTraining(
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
      WHERE session_id = ${sessionId}
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
          WHERE c.session_id = ${sessionId}
        )
    `);
  }

  /**
   * Roster membership becomes a course assignment — the whole roster in one
   * statement, so adding a department of 200 learners is still a single round
   * trip. Idempotent, so it can follow any roster change.
   */
  async assignRosterToTraining(
    sessionId: number,
    adminId: number,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_course_assignments
        (user_id, course_id, assigned_by, due_date)
      SELECT sr.user_id, c.id, ${adminId}, s.date
      FROM session_roster sr
      JOIN sessions s ON s.id = sr.session_id
      JOIN courses c ON c.session_id = sr.session_id
      WHERE sr.session_id = ${sessionId}
      ON CONFLICT (user_id, course_id) DO NOTHING
    `);
  }

  /** Leaving the roster withdraws the training and any credit for it. */
  async unassignFromTraining(
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
    `);

    await this.db.run(sql`
      DELETE FROM user_course_assignments uca
      USING courses c
      WHERE uca.course_id = c.id
        AND c.session_id = ${sessionId}
        AND uca.user_id = ${userId}
    `);
  }

  /** Learners the attendance record credits: present, late or partial. */
  async attendanceTally(sessionId: number) {
    const rows = await this.db.all<{ marked: number; credited: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status IS NOT NULL) AS marked,
        COUNT(*) FILTER (
          WHERE status IN ('present', 'late', 'partial')
        ) AS credited
      FROM session_attendance
      WHERE session_id = ${sessionId}
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
   */
  async syncCompletions(sessionId: number): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at)
      SELECT sa.user_id, l.id,
             LEAST(now(), (s.date::date + s.end_time::time)::timestamptz)
      FROM session_attendance sa
      JOIN sessions s ON s.id = sa.session_id
      JOIN courses c ON c.session_id = s.id
      JOIN course_modules cm ON cm.course_id = c.id
      JOIN lessons l ON l.module_id = cm.id AND l.content_type = 'session'
      WHERE sa.session_id = ${sessionId}
        AND sa.status IN ('present', 'late', 'partial')
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
        AND NOT EXISTS (
          SELECT 1 FROM session_attendance sa
          WHERE sa.session_id = ${sessionId}
            AND sa.user_id = ulc.user_id
            AND sa.status IN ('present', 'late', 'partial')
        )
    `);
  }

  /** Reopening a completed session withdraws every learner's credit. */
  async clearCompletions(sessionId: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM user_lesson_completions ulc
      USING lessons l, course_modules cm, courses c
      WHERE ulc.lesson_id = l.id
        AND l.module_id = cm.id
        AND cm.course_id = c.id
        AND c.session_id = ${sessionId}
        AND l.content_type = 'session'
    `);
  }

  /* ── Learner ── */

  async listForLearner(userId: number) {
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
      WHERE sr.user_id = ${userId}
      ORDER BY s.date ASC, s.start_time ASC
    `);
  }
}
