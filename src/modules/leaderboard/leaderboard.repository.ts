import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

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
   */
  async standings(
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
           AND to_char(c.completed_at, 'YYYY-MM') = ${thisMonth}) AS courses_month
      FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1
    `);
  }
}
