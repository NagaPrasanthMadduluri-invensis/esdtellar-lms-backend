import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import { DUE_DAYS } from '@/modules/learner/learner.constants';
import {
  PERFECT_SCORE,
  POINTS_ASSESSMENT_PASSED,
  POINTS_COURSE_COMPLETED,
  POINTS_FEEDBACK_SUBMITTED,
  POINTS_FINISHED_EARLY,
  POINTS_PERFECT_SCORE,
  POINTS_SESSION_ATTENDED,
  POINTS_TOP_SCORE,
  TOP_SCORE_THRESHOLD,
} from '@/modules/leaderboard/points';

export interface LeaderboardRow {
  id: number;
  first_name: string;
  last_name: string;
  department: string | null;
  /** DISTINCT assessments passed — not attempts. */
  passed: number;
  /** Every attempt, passing or not — the denominator for efficiency. */
  attempts: number;
  avg_score: number | null;
  courses_month: number;
  /** SUM over `pointEvents` — the only place points are computed. */
  points: number;
  month_points: number;
}

export interface PointEventRow {
  user_id: number;
  /** A `POINT_RULES` key. */
  rule: string;
  points: number;
  earned_at: string;
  detail: string;
}

/** The credit-earning attendance statuses — the same three §10.7 credits. */
const ATTENDED = sql`('present', 'late', 'partial')`;

@Injectable()
export class LeaderboardRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * EVERY POINTS-EARNING EVENT, as rows of (user, rule, points, when, what).
   *
   * This is the single definition of what pays (`points.ts` holds the
   * numbers). The standings SUM it and the points history LISTS it, so a
   * learner's history always adds up to the figure on the board — written as
   * two queries, those two would drift the first time a rule changed.
   *
   * Every branch is ACTIVITY and so carries `orgScope` on its own activity
   * table, never on the content it is about: a platform-owned course is
   * shared, but completing it happened in one tenant (§10.12).
   *
   *  course_completed / finished_early — every ACTIVE lesson of the course
   *    done, the definition `BadgesRepository.getStats` and the course cards
   *    use. "Early" is the Quick Learner badge's own test: last lesson on or
   *    before assigned_at + DUE_DAYS. A session's companion course pays
   *    attendance instead, and an external certification pays nothing.
   *  assessment tiers — ONE row per assessment, from the best PASSING score,
   *    dated when that score was first reached. Mirrors
   *    `assessmentTierPoints()` with the same constants.
   *  feedback_submitted — one row per course_feedback / session_feedback row,
   *    which are already unique per (user, course|session).
   *  session_attended — credited attendance on a session marked completed,
   *    dated by the session. Requiring `completed` is what keeps this in step
   *    with the training it credits, which also waits for completion.
   *  journey_completed — the path's own `points_bonus`.
   *
   * `userId` narrows every branch for the history read; omitted, it covers
   * the whole organization for the standings.
   */
  private pointEvents(scope: OrgScope, userId?: number): SQL {
    const forUser = (alias: string) =>
      userId === undefined ? sql`` : sql`AND ${sql.identifier(alias)}.user_id = ${userId}`;

    return sql`(
      WITH course_done AS (
        SELECT a.user_id, c.name AS course_name, a.assigned_at,
               MAX(ulc.completed_at) AS done_at
        FROM user_course_assignments a
        JOIN courses c ON c.id = a.course_id
         AND c.session_id IS NULL
         AND c.external_certification_id IS NULL
        JOIN course_modules cm ON cm.course_id = c.id AND cm.is_active = 1
        JOIN lessons l ON l.module_id = cm.id AND l.is_active = 1
        LEFT JOIN user_lesson_completions ulc
          ON ulc.lesson_id = l.id AND ulc.user_id = a.user_id
        WHERE ${orgScope('a', scope)} ${forUser('a')}
        GROUP BY a.user_id, a.course_id, c.name, a.assigned_at
        HAVING COUNT(ulc.lesson_id) = COUNT(*)
      ),
      best_pass AS (
        SELECT t.user_id, t.assessment_id, MAX(t.percentage) AS best_pct
        FROM user_assessment_attempts t
        WHERE t.is_passed = 1 AND ${orgScope('t', scope)} ${forUser('t')}
        GROUP BY t.user_id, t.assessment_id
      )
      SELECT user_id, 'course_completed' AS rule,
             ${POINTS_COURSE_COMPLETED}::int AS points,
             done_at AS earned_at, course_name AS detail
      FROM course_done

      UNION ALL
      SELECT user_id, 'finished_early', ${POINTS_FINISHED_EARLY}::int,
             done_at, course_name
      FROM course_done
      WHERE done_at::date <= (assigned_at::date + ${DUE_DAYS}::int)

      UNION ALL
      SELECT b.user_id,
             CASE WHEN b.best_pct >= ${PERFECT_SCORE} THEN 'perfect_score'
                  WHEN b.best_pct >= ${TOP_SCORE_THRESHOLD} THEN 'top_score'
                  ELSE 'assessment_passed' END,
             CASE WHEN b.best_pct >= ${PERFECT_SCORE} THEN ${POINTS_PERFECT_SCORE}::int
                  WHEN b.best_pct >= ${TOP_SCORE_THRESHOLD} THEN ${POINTS_TOP_SCORE}::int
                  ELSE ${POINTS_ASSESSMENT_PASSED}::int END,
             (SELECT MIN(t.submitted_at) FROM user_assessment_attempts t
               WHERE t.user_id = b.user_id AND t.assessment_id = b.assessment_id
                 AND t.is_passed = 1 AND t.percentage = b.best_pct
                 AND ${orgScope('t', scope)}),
             a.title
      FROM best_pass b
      JOIN assessments a ON a.id = b.assessment_id

      UNION ALL
      SELECT f.user_id, 'feedback_submitted', ${POINTS_FEEDBACK_SUBMITTED}::int,
             f.created_at, c.name
      FROM course_feedback f
      JOIN courses c ON c.id = f.course_id
      WHERE ${orgScope('f', scope)} ${forUser('f')}

      UNION ALL
      SELECT sf.user_id, 'feedback_submitted', ${POINTS_FEEDBACK_SUBMITTED}::int,
             sf.created_at, s.title
      FROM session_feedback sf
      JOIN sessions s ON s.id = sf.session_id
      WHERE ${orgScope('sf', scope)} ${forUser('sf')}

      UNION ALL
      SELECT sa.user_id, 'session_attended', ${POINTS_SESSION_ATTENDED}::int,
             s.date::timestamptz, s.title
      FROM session_attendance sa
      JOIN sessions s ON s.id = sa.session_id AND s.status = 'completed'
      WHERE sa.status IN ${ATTENDED} AND ${orgScope('sa', scope)} ${forUser('sa')}

      UNION ALL
      SELECT je.user_id, 'journey_completed', j.points_bonus,
             je.completed_at, j.title
      FROM journey_enrollments je
      JOIN journeys j ON j.id = je.journey_id
      WHERE je.completed_at IS NOT NULL AND j.points_bonus > 0
        AND ${orgScope('je', scope)} ${forUser('je')}
    )`;
  }

  /**
   * One row per active learner, with everything the standings and the
   * recognition cards need.
   *
   * Two things here are deliberate and were previously wrong:
   *
   *  - passes are `COUNT(DISTINCT assessment_id)`. Counting rows meant a
   *    learner who re-took an assessment they had ALREADY passed got credit
   *    again. (Points now come from `pointEvents`, which pays one tier per
   *    assessment for the same reason.)
   *  - `is_active = 1`. Deactivated learners used to keep competing, and the
   *    admin dashboard's own user count already excluded them, so the same
   *    admin saw two different totals.
   *
   * `points` / `month_points` are `pointEvents` summed in SQL (§7.2), in the
   * same round trip.
   */
  async standings(
    scope: OrgScope,
    thisMonth: string,
  ): Promise<LeaderboardRow[]> {
    return this.db.all<LeaderboardRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.department,
        (SELECT COUNT(DISTINCT t.assessment_id) FROM user_assessment_attempts t
         WHERE t.user_id = u.id AND t.is_passed = 1) AS passed,
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
        COALESCE(p.points, 0) AS points,
        COALESCE(p.month_points, 0) AS month_points
      FROM users u
      LEFT JOIN (
        SELECT ev.user_id,
               SUM(ev.points) AS points,
               SUM(CASE WHEN to_char(ev.earned_at, 'YYYY-MM') = ${thisMonth}
                        THEN ev.points ELSE 0 END) AS month_points
        FROM ${this.pointEvents(scope)} ev
        GROUP BY ev.user_id
      ) p ON p.user_id = u.id
      WHERE u.role = 'learner' AND u.is_active = 1 AND ${orgScope('u', scope)}
    `);
  }

  /** One learner's point events, newest first — the Achievements history. */
  async history(scope: OrgScope, userId: number, limit: number): Promise<PointEventRow[]> {
    return this.db.all<PointEventRow>(sql`
      SELECT ev.user_id, ev.rule, ev.points, ev.earned_at, ev.detail
      FROM ${this.pointEvents(scope, userId)} ev
      ORDER BY ev.earned_at DESC NULLS LAST
      LIMIT ${limit}
    `);
  }
}
