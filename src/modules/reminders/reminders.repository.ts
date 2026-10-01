import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

export interface DueSoonRow {
  user_id: number;
  organization_id: number;
  course_id: number;
  course_name: string;
  due_date: string;
  days_left: number;
}

/**
 * The queries behind the scheduled reminders.
 *
 * Raw SQL throughout, snake_case throughout — no casing seam (§10.10).
 */
@Injectable()
export class RemindersRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Assignments falling due within `windowDays` that the learner has NOT
   * finished.
   *
   * ## "Not finished" means the same thing it means everywhere else
   *
   * Every assigned, active lesson completed — the definition §10.11 uses
   * and that `getCompletionSnapshot` implements. A reminder built on a
   * different definition would nag people who had actually finished, which
   * is the fastest way to teach somebody to ignore the sender.
   *
   * A course with NO lessons is excluded rather than treated as incomplete:
   * there is nothing the learner could do about it, and a nag you cannot
   * act on is worse than silence.
   *
   * ## One query, every tenant
   *
   * This runs once a day for the whole platform, so it is deliberately not
   * org-scoped — the caller fans the results out per recipient. The
   * organization travels on the row so each notification is written to the
   * right tenant.
   */
  async dueSoon(windowDays: number): Promise<DueSoonRow[]> {
    return this.db.all<DueSoonRow>(sql`
      SELECT a.user_id,
             a.organization_id,
             a.course_id,
             c.name AS course_name,
             a.due_date,
             (a.due_date::date - CURRENT_DATE) AS days_left
        FROM user_course_assignments a
        JOIN courses c ON c.id = a.course_id
        JOIN users   u ON u.id = a.user_id
        JOIN organizations o ON o.id = a.organization_id
       WHERE a.due_date IS NOT NULL
         AND a.due_date <> ''
         AND a.due_date::date >= CURRENT_DATE
         AND a.due_date::date <= CURRENT_DATE + (${windowDays} * INTERVAL '1 day')
         AND u.is_active = 1
         AND o.is_active = 1
         AND c.is_active = 1
         -- A session's companion training is completed by attendance, not by
         -- the learner (§10.7), and an external certification is already
         -- finished. Nagging about either would be nagging about something
         -- they cannot do.
         AND c.session_id IS NULL
         AND c.external_certification_id IS NULL
         -- Has at least one deliverable lesson...
         AND EXISTS (
           SELECT 1 FROM lessons l
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = c.id AND l.is_active = 1 AND cm.is_active = 1
         )
         -- ...and at least one of them is still outstanding.
         AND EXISTS (
           SELECT 1 FROM lessons l
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = c.id AND l.is_active = 1 AND cm.is_active = 1
              AND NOT EXISTS (
                SELECT 1 FROM user_lesson_completions ulc
                 WHERE ulc.lesson_id = l.id AND ulc.user_id = a.user_id
              )
         )
       ORDER BY a.user_id, a.due_date
    `);
  }

  /**
   * Who has already been reminded about this course recently.
   *
   * Reads `notifications` rather than a table of its own. The bell row is
   * written by the same call that sends the email, so it is an accurate
   * record of "we already told them" — and one fewer table to keep in step.
   */
  async recentlyReminded(sinceDays: number): Promise<Set<string>> {
    const rows = await this.db.all<{ user_id: number; subject_id: number }>(sql`
      SELECT DISTINCT user_id, subject_id
        FROM notifications
       WHERE type = 'course_due_soon'
         AND subject_id IS NOT NULL
         AND created_at > NOW() - (${sinceDays} * INTERVAL '1 day')
    `);
    return new Set(rows.map((r) => `${r.user_id}:${r.subject_id}`));
  }
}
