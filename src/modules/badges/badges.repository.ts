import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import { DUE_DAYS } from '@/modules/learner/learner.constants';

/**
 * Every number a catalogue badge's `threshold` (`common/badges.ts`) is
 * compared against, except `points` — that comes from
 * `LeaderboardService.standings()` instead of a second formula here, so a
 * badge can never disagree with what the board actually pays (§10.5).
 */
export interface BadgeStatsRow {
  completed_courses: number;
  completed_before_due: number;
  max_assessment_score: number;
  journeys_completed: number;
}

export interface EarnedBadgeRow {
  badge_key: string;
  earned_at: string;
  journey_id: number | null;
  journey_title: string | null;
  journey_badge_label: string | null;
  journey_badge_icon: string | null;
}

@Injectable()
export class BadgesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * ONE round trip, the same correlated-subquery idiom as
   * `CertificatesRepository.getCompletionSnapshot()`. `course_stats` mirrors
   * exactly the completeness test `LearnerRepository.assignedCourses()` /
   * `LearnerService`'s own `isComplete` already use (total active lessons > 0
   * AND every one of them done) — a second, looser definition here would
   * award a badge the achievements page itself would not show as complete.
   */
  async getStats(scope: OrgScope, userId: number): Promise<BadgeStatsRow> {
    const rows = await this.db.all<BadgeStatsRow>(sql`
      WITH course_stats AS (
        SELECT a.course_id, a.user_id, a.assigned_at,
          (SELECT COUNT(*) FROM lessons l
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = a.course_id
              AND l.is_active = 1 AND cm.is_active = 1) AS total_lessons,
          (SELECT COUNT(*) FROM user_lesson_completions ulc
             JOIN lessons l ON l.id = ulc.lesson_id
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = a.course_id AND ulc.user_id = a.user_id
              AND l.is_active = 1 AND cm.is_active = 1) AS completed_lessons,
          (SELECT MAX(ulc.completed_at) FROM user_lesson_completions ulc
             JOIN lessons l ON l.id = ulc.lesson_id
             JOIN course_modules cm ON cm.id = l.module_id
            WHERE cm.course_id = a.course_id
              AND ulc.user_id = a.user_id) AS last_activity
        FROM user_course_assignments a
        JOIN courses c ON c.id = a.course_id
        -- Scoped on the ASSIGNMENT, not the course. An assignment is activity
        -- and always carries the learner's own org; a course may be owned by
        -- the PLATFORM org and shared with every tenant. Filtering the course
        -- by the learner's org therefore dropped every global course from the
        -- count, and because badges are now stored on award rather than
        -- recomputed, a learner whose courses were global would have lost
        -- first_steps/committed_learner/scholar permanently.
        WHERE a.user_id = ${userId} AND ${orgScope('a', scope)}
      )
      SELECT
        (SELECT COUNT(*) FROM course_stats
           WHERE total_lessons > 0
             AND completed_lessons >= total_lessons) AS completed_courses,
        -- Same window LearnerService's rewardMapper/achievements() used:
        -- last activity on or before assigned_at + DUE_DAYS.
        (SELECT COUNT(*) FROM course_stats
           WHERE total_lessons > 0
             AND completed_lessons >= total_lessons
             AND last_activity IS NOT NULL
             AND last_activity::date <= (assigned_at::date + ${DUE_DAYS}::int)
        ) AS completed_before_due,
        -- Attempts are activity too: the org predicate on the attempt IS the
        -- whole scope, and the courses join it used to need has gone with it.
        (SELECT COALESCE(MAX(t.percentage), 0) FROM user_assessment_attempts t
          WHERE t.user_id = ${userId}
            AND ${orgScope('t', scope)}) AS max_assessment_score,
        (SELECT COUNT(*) FROM journey_enrollments je
          WHERE je.user_id = ${userId} AND je.completed_at IS NOT NULL
            AND je.organization_id = ${scope.organizationId}) AS journeys_completed
    `);

    return rows[0];
  }

  /** Every badge this learner already holds, journey ones labelled from the journey row. */
  async listEarned(scope: OrgScope, userId: number): Promise<EarnedBadgeRow[]> {
    return this.db.all<EarnedBadgeRow>(sql`
      SELECT ub.badge_key, ub.earned_at, ub.journey_id,
             j.title AS journey_title,
             j.badge_label AS journey_badge_label,
             j.badge_icon AS journey_badge_icon
      FROM user_badges ub
      LEFT JOIN journeys j ON j.id = ub.journey_id
      WHERE ub.user_id = ${userId} AND ub.organization_id = ${scope.organizationId}
      ORDER BY ub.earned_at DESC
    `);
  }

  /**
   * Single-badge award — used for a per-journey badge (`journey:<id>`), which
   * carries `journeyId` for the label/icon join above. Idempotent: a second
   * award for the same (user, badge) is a no-op, never a duplicate row or a
   * thrown unique-violation.
   */
  async award(
    scope: OrgScope,
    userId: number,
    badgeKey: string,
    journeyId: number | null,
  ): Promise<boolean> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO user_badges (organization_id, user_id, badge_key, journey_id, earned_at)
      VALUES (${scope.organizationId}, ${userId}, ${badgeKey}, ${journeyId}, now())
      ON CONFLICT (user_id, badge_key) DO NOTHING
      RETURNING id
    `);
    return rows.length > 0;
  }

  /**
   * ONE multi-row INSERT for every newly-eligible catalogue badge (§7.1 —
   * never one statement per badge). `sql.join` builds the VALUES list because
   * interpolating a JS array as a single parameter renders as a Postgres
   * record, not a set of rows (the same reason `RolesRepository.replacePermissions`
   * builds its rows this way).
   */
  async awardMany(
    scope: OrgScope,
    userId: number,
    badgeKeys: readonly string[],
  ): Promise<string[]> {
    if (badgeKeys.length === 0) return [];

    const rows = badgeKeys.map(
      (key) => sql`(${scope.organizationId}, ${userId}, ${key}, NULL, now())`,
    );
    const inserted = await this.db.all<{ badge_key: string }>(sql`
      INSERT INTO user_badges (organization_id, user_id, badge_key, journey_id, earned_at)
      VALUES ${sql.join(rows, sql`, `)}
      ON CONFLICT (user_id, badge_key) DO NOTHING
      RETURNING badge_key
    `);
    return inserted.map((r) => r.badge_key);
  }
}
