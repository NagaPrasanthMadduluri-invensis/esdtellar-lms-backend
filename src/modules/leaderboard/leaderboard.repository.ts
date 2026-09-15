import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

export interface LeaderboardRow {
  id: number;
  first_name: string;
  last_name: string;
  department: string | null;
  lessons: number;
  lessons_month: number;
  /** DISTINCT assessments passed — not attempts. */
  passed: number;
  passed_month: number;
  /** Every attempt, passing or not — the denominator for efficiency. */
  attempts: number;
  avg_score: number | null;
  courses_month: number;
  /**
   * Sum of `points_bonus` over this learner's COMPLETED journeys (spec §4.4)
   * — a journey's own bonus, not a flat constant, because a 3-course path and
   * a 12-course path are not worth the same.
   */
  journey_points: number;
  journey_points_month: number;
}

@Injectable()
export class LeaderboardRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * One row per active learner, with everything the standings and the
   * recognition cards need.
   *
   * Two things here are deliberate and were previously wrong:
   *
   *  - passes are `COUNT(DISTINCT assessment_id)`. Counting rows meant a
   *    learner who re-took an assessment they had ALREADY passed earned the
   *    points again, so the board could be farmed by repeating one quiz.
   *  - `is_active = 1`. Deactivated learners used to keep competing, and the
   *    admin dashboard's own user count already excluded them, so the same
   *    admin saw two different totals.
   *
   * `journey_points` / `journey_points_month` are the ONLY place a journey's
   * `points_bonus` is summed (spec §4.4, BACKEND_STRUCTURE.md §10.5) — folded
   * into `points`/`monthPoints` by `LeaderboardService`, never recomputed a
   * second way, so the learner board and the admin board cannot disagree.
   */
  async standings(
    scope: OrgScope,
    thisMonth: string,
  ): Promise<LeaderboardRow[]> {
    return this.db.all<LeaderboardRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.department,
        (SELECT COUNT(*) FROM user_lesson_completions c
         WHERE c.user_id = u.id) AS lessons,
        (SELECT COUNT(*) FROM user_lesson_completions c
         WHERE c.user_id = u.id
           AND to_char(c.completed_at, 'YYYY-MM') = ${thisMonth}) AS lessons_month,
        (SELECT COUNT(DISTINCT t.assessment_id) FROM user_assessment_attempts t
         WHERE t.user_id = u.id AND t.is_passed = 1) AS passed,
        (SELECT COUNT(DISTINCT t.assessment_id) FROM user_assessment_attempts t
         WHERE t.user_id = u.id AND t.is_passed = 1
           AND to_char(t.submitted_at, 'YYYY-MM') = ${thisMonth}) AS passed_month,
        (SELECT COUNT(*) FROM user_assessment_attempts t
         WHERE t.user_id = u.id) AS attempts,
        (SELECT AVG(t.percentage) FROM user_assessment_attempts t
         WHERE t.user_id = u.id) AS avg_score,
        (SELECT COUNT(DISTINCT cm.course_id)
         FROM user_lesson_completions c
         JOIN lessons l ON l.id = c.lesson_id
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE c.user_id = u.id
           AND to_char(c.completed_at, 'YYYY-MM') = ${thisMonth}) AS courses_month,
        (SELECT COALESCE(SUM(j.points_bonus), 0)
         FROM journey_enrollments je
         JOIN journeys j ON j.id = je.journey_id
         WHERE je.user_id = u.id AND je.completed_at IS NOT NULL) AS journey_points,
        (SELECT COALESCE(SUM(j.points_bonus), 0)
         FROM journey_enrollments je
         JOIN journeys j ON j.id = je.journey_id
         WHERE je.user_id = u.id AND je.completed_at IS NOT NULL
           AND to_char(je.completed_at, 'YYYY-MM') = ${thisMonth}) AS journey_points_month
      FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1 AND ${orgScope('u', scope)}
    `);
  }
}
