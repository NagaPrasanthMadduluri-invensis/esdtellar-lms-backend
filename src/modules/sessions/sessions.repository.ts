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
        (SELECT COUNT(*) FROM session_roster sr
         WHERE sr.session_id = s.id) AS roster_count
      FROM sessions s
      LEFT JOIN courses c ON c.id = s.course_id
      ORDER BY s.date DESC, s.start_time DESC
    `);
  }

  async findWithCourse(sessionId: number) {
    const rows = await this.db.all(sql`
      SELECT s.*, c.name AS course_name
      FROM sessions s
      LEFT JOIN courses c ON c.id = s.course_id
      WHERE s.id = ${sessionId}
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
      INSERT OR IGNORE INTO session_roster (session_id, user_id)
      SELECT ${sessionId}, u.id FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1
        AND u.department = ${department}
        AND u.id NOT IN (
          SELECT user_id FROM session_roster WHERE session_id = ${sessionId}
        )
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
                ${adminId}, ${isLocked}, datetime('now'))
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

  /* ── Learner ── */

  async listForLearner(userId: number) {
    return this.db.all(sql`
      SELECT s.id, s.title, s.session_type, s.department, s.date,
             s.start_time, s.end_time, s.trainer, s.venue_url,
             s.description, s.status, s.capacity,
             c.name AS course_name,
             sa.status AS attendance_status
      FROM session_roster sr
      JOIN sessions s ON s.id = sr.session_id
      LEFT JOIN courses c ON c.id = s.course_id
      LEFT JOIN session_attendance sa
        ON sa.session_id = sr.session_id AND sa.user_id = sr.user_id
      WHERE sr.user_id = ${userId}
      ORDER BY s.date ASC, s.start_time ASC
    `);
  }
}
