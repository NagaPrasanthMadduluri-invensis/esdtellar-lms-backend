import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

/**
 * One row per learner, carrying every aggregate the analytics endpoints need.
 *
 * The legacy handlers each looped over learners issuing 2–6 follow-up queries
 * apiece (reports, departments, leaderboard, learning-hours and export all did
 * their own version). With 19 learners that was well over 300 round trips
 * across those five endpoints. This is one query, reused by all of them.
 */
export interface LearnerStatsRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  department: string | null;
  job_role: string | null;
  location: string | null;
  best_score: number | null;
  has_passed: number | null;
  attempt_count: number;
  completed_lessons: number;
  assigned_lessons: number;
  all_time_minutes: number;
  this_month_minutes: number;
  last_month_minutes: number;
}

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async learnerStats(
    scope: OrgScope,
    thisMonth: string,
    lastMonth: string,
  ): Promise<LearnerStatsRow[]> {
    return this.db.all<LearnerStatsRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email,
             u.department, u.job_role, u.location,
             (SELECT MAX(percentage) FROM user_assessment_attempts t
              WHERE t.user_id = u.id) AS best_score,
             (SELECT MAX(is_passed) FROM user_assessment_attempts t
              WHERE t.user_id = u.id) AS has_passed,
             (SELECT COUNT(*) FROM user_assessment_attempts t
              WHERE t.user_id = u.id) AS attempt_count,
             (SELECT COUNT(*) FROM user_lesson_completions c
              WHERE c.user_id = u.id) AS completed_lessons,
             (SELECT COUNT(DISTINCT l.id)
              FROM user_course_assignments uca
              JOIN course_modules cm ON cm.course_id = uca.course_id
              JOIN lessons l ON l.module_id = cm.id
              WHERE uca.user_id = u.id) AS assigned_lessons,
             (SELECT COALESCE(SUM(l.duration_minutes), 0)
              FROM user_lesson_completions c
              JOIN lessons l ON l.id = c.lesson_id
              WHERE c.user_id = u.id) AS all_time_minutes,
             (SELECT COALESCE(SUM(l.duration_minutes), 0)
              FROM user_lesson_completions c
              JOIN lessons l ON l.id = c.lesson_id
              WHERE c.user_id = u.id
                AND to_char(c.completed_at, 'YYYY-MM') = ${thisMonth}) AS this_month_minutes,
             (SELECT COALESCE(SUM(l.duration_minutes), 0)
              FROM user_lesson_completions c
              JOIN lessons l ON l.id = c.lesson_id
              WHERE c.user_id = u.id
                AND to_char(c.completed_at, 'YYYY-MM') = ${lastMonth}) AS last_month_minutes
      FROM users u
      WHERE u.role = 'learner' AND ${orgScope('u', scope)}
      ORDER BY u.first_name, u.last_name
    `);
  }

  /** Per-learner, per-course progress — powers the export's row-per-course sheet. */
  async courseProgressPerLearner(scope: OrgScope) {
    return this.db.all<{
      user_id: number;
      course_id: number;
      course_name: string;
      assigned_at: string;
      total_lessons: number;
      completed_lessons: number;
      best_score: number | null;
      has_passed: number | null;
      attempt_count: number;
    }>(sql`
      SELECT uca.user_id, uca.course_id, c.name AS course_name, uca.assigned_at,
             (SELECT COUNT(*)
              FROM lessons l
              JOIN course_modules cm ON cm.id = l.module_id
              WHERE cm.course_id = uca.course_id
                AND l.is_active = 1 AND cm.is_active = 1) AS total_lessons,
             (SELECT COUNT(*)
              FROM user_lesson_completions ulc
              JOIN lessons l ON l.id = ulc.lesson_id
              JOIN course_modules cm ON cm.id = l.module_id
              WHERE cm.course_id = uca.course_id
                AND l.is_active = 1 AND cm.is_active = 1
                AND ulc.user_id = uca.user_id) AS completed_lessons,
             (SELECT MAX(t.percentage)
              FROM user_assessment_attempts t
              JOIN assessments a ON a.id = t.assessment_id
              WHERE a.course_id = uca.course_id AND t.user_id = uca.user_id) AS best_score,
             (SELECT MAX(t.is_passed)
              FROM user_assessment_attempts t
              JOIN assessments a ON a.id = t.assessment_id
              WHERE a.course_id = uca.course_id AND t.user_id = uca.user_id) AS has_passed,
             (SELECT COUNT(*)
              FROM user_assessment_attempts t
              JOIN assessments a ON a.id = t.assessment_id
              WHERE a.course_id = uca.course_id AND t.user_id = uca.user_id) AS attempt_count
      FROM user_course_assignments uca
      JOIN courses c ON c.id = uca.course_id AND c.is_active = 1
      WHERE ${orgScope('uca', scope)}
      ORDER BY uca.user_id, uca.assigned_at
    `);
  }

  /* ── Admin dashboard ── */

  /**
   * Four independent scalar subqueries with no shared FROM (§ same reasoning
   * as `CertificatesRepository.getCompletionSnapshot`) — each has to re-anchor
   * on `scope` itself rather than trust a driving row it does not have.
   */
  async dashboardCounts(scope: OrgScope) {
    const rows = await this.db.all<{
      total_courses: number;
      total_users: number;
      total_assigned: number;
      total_completed: number;
    }>(sql`
      SELECT
        (SELECT COUNT(*) FROM courses
         WHERE is_active = 1 AND organization_id = ${scope.organizationId}) AS total_courses,
        (SELECT COUNT(*) FROM users
         WHERE role = 'learner' AND is_active = 1
           AND organization_id = ${scope.organizationId}) AS total_users,
        (SELECT COUNT(*) FROM user_course_assignments
         WHERE organization_id = ${scope.organizationId}) AS total_assigned,
        (SELECT COUNT(*) FROM user_course_assignments uca
         WHERE uca.organization_id = ${scope.organizationId}
           AND (SELECT COUNT(*) FROM lessons l
                JOIN course_modules cm ON cm.id = l.module_id
                WHERE cm.course_id = uca.course_id
                  AND l.is_active = 1 AND cm.is_active = 1) > 0
           AND (SELECT COUNT(*) FROM lessons l
                JOIN course_modules cm ON cm.id = l.module_id
                WHERE cm.course_id = uca.course_id
                  AND l.is_active = 1 AND cm.is_active = 1)
             = (SELECT COUNT(*) FROM user_lesson_completions ulc
                JOIN lessons l ON l.id = ulc.lesson_id
                JOIN course_modules cm ON cm.id = l.module_id
                WHERE cm.course_id = uca.course_id
                  AND ulc.user_id = uca.user_id)) AS total_completed
    `);
    return rows[0];
  }

  async recentUsers(scope: OrgScope) {
    return this.db.all<{
      id: number;
      first_name: string;
      last_name: string;
      email: string;
      created_at: string;
    }>(sql`
      SELECT id, first_name, last_name, email, created_at
      FROM users u WHERE role = 'learner' AND ${orgScope('u', scope)}
      ORDER BY created_at DESC LIMIT 5
    `);
  }

  async recentAttempts(scope: OrgScope) {
    return this.db.all(sql`
      SELECT ua.*, u.first_name, u.last_name,
             a.title AS assessment_title, c.name AS course_name
      FROM user_assessment_attempts ua
      JOIN users u ON u.id = ua.user_id
      JOIN assessments a ON a.id = ua.assessment_id
      JOIN courses c ON c.id = a.course_id
      WHERE ${orgScope('ua', scope)}
      ORDER BY ua.submitted_at DESC LIMIT 5
    `);
  }

  /* ── Reports extras ── */

  async activeCourseCount(scope: OrgScope): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(DISTINCT course_id) AS n FROM user_course_assignments uca
      WHERE ${orgScope('uca', scope)}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /** Assignments due within two days whose lessons are not all complete. */
  async overdueCourseCount(scope: OrgScope): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM user_course_assignments uca
      WHERE uca.due_date IS NOT NULL
        AND uca.due_date::date <= CURRENT_DATE + 2
        AND ${orgScope('uca', scope)}
        AND (SELECT COUNT(*) FROM user_lesson_completions ulc
             JOIN lessons l ON l.id = ulc.lesson_id
             JOIN course_modules cm ON cm.id = l.module_id
             WHERE cm.course_id = uca.course_id AND ulc.user_id = uca.user_id)
          < (SELECT COUNT(*) FROM lessons l2
             JOIN course_modules cm2 ON cm2.id = l2.module_id
             WHERE cm2.course_id = uca.course_id
               AND l2.is_active = 1 AND cm2.is_active = 1)
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /* ── Learning hours: weekly rollups (already set-based in the legacy code) ── */

  private readonly weekCase = (column: string) => sql.raw(`CASE
    WHEN CAST(to_char(${column}, 'DD') AS INTEGER) <= 7  THEN 'W1'
    WHEN CAST(to_char(${column}, 'DD') AS INTEGER) <= 14 THEN 'W2'
    WHEN CAST(to_char(${column}, 'DD') AS INTEGER) <= 21 THEN 'W3'
    ELSE 'W4'
  END`);

  async weeklyHoursByDepartment(scope: OrgScope, month: string) {
    return this.db.all<{ week: string; dept: string; hrs: number }>(sql`
      SELECT ${this.weekCase('ulc.completed_at')} AS week,
             u.department AS dept,
             ROUND(SUM(l.duration_minutes) / 60.0, 1) AS hrs
      FROM user_lesson_completions ulc
      JOIN users u ON u.id = ulc.user_id
      JOIN lessons l ON l.id = ulc.lesson_id
      WHERE u.role = 'learner'
        AND to_char(ulc.completed_at, 'YYYY-MM') = ${month}
        AND u.department IS NOT NULL
        AND ${orgScope('ulc', scope)}
      GROUP BY week, u.department
      ORDER BY week, u.department
    `);
  }

  async weeklyEnrollments(scope: OrgScope, month: string) {
    return this.db.all<{ week: string; cnt: number }>(sql`
      SELECT ${this.weekCase('uca.assigned_at')} AS week,
             COUNT(DISTINCT uca.user_id) AS cnt
      FROM user_course_assignments uca
      WHERE to_char(uca.assigned_at, 'YYYY-MM') = ${month}
        AND ${orgScope('uca', scope)}
      GROUP BY week
    `);
  }

  async weeklyCompletions(scope: OrgScope, month: string) {
    return this.db.all<{ week: string; cnt: number }>(sql`
      SELECT ${this.weekCase('sub.last_completion')} AS week,
             COUNT(DISTINCT sub.user_id) AS cnt
      FROM (
        SELECT uca.user_id, uca.course_id,
               MAX(ulc.completed_at) AS last_completion,
               COUNT(ulc.id) AS done_count
        FROM user_course_assignments uca
        JOIN course_modules cm ON cm.course_id = uca.course_id AND cm.is_active = 1
        JOIN lessons l ON l.module_id = cm.id AND l.is_active = 1
        JOIN user_lesson_completions ulc
          ON ulc.lesson_id = l.id AND ulc.user_id = uca.user_id
        WHERE ${orgScope('uca', scope)}
        GROUP BY uca.user_id, uca.course_id
        HAVING COUNT(ulc.id) = (
          SELECT COUNT(*) FROM lessons l2
          JOIN course_modules cm2 ON cm2.id = l2.module_id
          WHERE cm2.course_id = uca.course_id
            AND l2.is_active = 1 AND cm2.is_active = 1
        )
      ) sub
      WHERE to_char(sub.last_completion, 'YYYY-MM') = ${month}
      GROUP BY week
    `);
  }

  /** Top scorers for the export leaderboard sheet. */
  async topScorers(scope: OrgScope, limit: number) {
    return this.db.all<{
      id: number;
      first_name: string;
      last_name: string;
      department: string | null;
      best_score: number;
    }>(sql`
      SELECT u.id, u.first_name, u.last_name, u.department,
             MAX(uaa.percentage) AS best_score
      FROM users u
      JOIN user_assessment_attempts uaa ON uaa.user_id = u.id
      WHERE u.role = 'learner' AND ${orgScope('u', scope)}
      GROUP BY u.id
      ORDER BY best_score DESC
      LIMIT ${limit}
    `);
  }
}
