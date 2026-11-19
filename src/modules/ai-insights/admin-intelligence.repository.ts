import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';

export interface InactivityRow {
  total: number;
  inactive: number;
}

export interface CourseEffectivenessRow {
  course_id: number;
  name: string;
  category: string | null;
  enrolled: number;
  lessons: number;
  lesson_completions: number;
  avg_score: number | null;
  assessments: number;
}

export interface SkillDomainRow {
  domain: string;
  learners: number;
  avg_level_pct: number;
}

/**
 * Real-data aggregates for the admin Learning Intelligence view (Phase 1/2 +
 * differentiators): inactivity, course effectiveness, dropout and organisational
 * skill intelligence. Deterministic and accurate — the LLM narrates these, it
 * does not invent them (§10.54). Everything is tenant-scoped: content with
 * `contentScope`, activity with `orgScope` (§10.12).
 */
@Injectable()
export class AdminIntelligenceRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Active learners with no lesson completion or assessment attempt in `days`. */
  async inactivity(scope: OrgScope, days: number): Promise<InactivityRow> {
    const rows = await this.db.all<InactivityRow>(sql`
      WITH learners AS (
        SELECT u.id
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.organization_id = ${scope.organizationId}
          AND u.is_active = 1 AND r.portal = 'learner'
      ),
      last_act AS (
        SELECT user_id, MAX(ts) AS last_at FROM (
          SELECT user_id, completed_at AS ts FROM user_lesson_completions
            WHERE organization_id = ${scope.organizationId}
          UNION ALL
          SELECT user_id, submitted_at AS ts FROM user_assessment_attempts
            WHERE organization_id = ${scope.organizationId}
        ) a GROUP BY user_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM learners) AS total,
        COUNT(*) FILTER (
          WHERE la.last_at IS NULL
             OR la.last_at < now() - (${days} || ' days')::interval
        )::int AS inactive
      FROM learners l
      LEFT JOIN last_act la ON la.user_id = l.id
    `);
    return rows[0] ?? { total: 0, inactive: 0 };
  }

  /**
   * Per-course effectiveness signals for courses with at least one enrolment.
   * `lesson_completions / (enrolled * lessons)` is a content-completion rate
   * (how much of the material has been consumed) — labelled as such, not the
   * all-lessons-done completion definition, which is kept to §10.11.
   */
  async courseEffectiveness(scope: OrgScope): Promise<CourseEffectivenessRow[]> {
    return this.db.all<CourseEffectivenessRow>(sql`
      SELECT
        c.id AS course_id, c.name, c.category,
        (SELECT COUNT(*)::int FROM user_course_assignments uca
           WHERE uca.course_id = c.id AND ${orgScope('uca', scope)}) AS enrolled,
        (SELECT COUNT(*)::int FROM lessons l
           WHERE l.course_id = c.id AND l.is_active = 1) AS lessons,
        (SELECT COUNT(*)::int FROM user_lesson_completions ulc
           JOIN lessons l2 ON l2.id = ulc.lesson_id AND l2.course_id = c.id
           WHERE ${orgScope('ulc', scope)}) AS lesson_completions,
        (SELECT ROUND(AVG(uaa.percentage))::int FROM user_assessment_attempts uaa
           JOIN assessments a ON a.id = uaa.assessment_id AND a.course_id = c.id
           WHERE ${orgScope('uaa', scope)} AND uaa.is_passed = 1) AS avg_score,
        (SELECT COUNT(*)::int FROM assessments a2
           WHERE a2.course_id = c.id AND a2.is_active = 1) AS assessments
      FROM courses c
      WHERE ${contentScope('c', scope)}
        AND c.is_active = 1 AND c.archived_at IS NULL
        AND c.session_id IS NULL AND c.external_certification_id IS NULL
        AND EXISTS (SELECT 1 FROM user_course_assignments uca2
                      WHERE uca2.course_id = c.id AND ${orgScope('uca2', scope)})
      ORDER BY enrolled DESC
      LIMIT 50
    `);
  }

  /** Competency coverage per skill domain, from gained skills (orgScope). */
  async skillDomains(scope: OrgScope): Promise<SkillDomainRow[]> {
    return this.db.all<SkillDomainRow>(sql`
      SELECT COALESCE(s.domain, 'General') AS domain,
             COUNT(DISTINCT us.user_id)::int AS learners,
             ROUND(AVG(CASE us.level
               WHEN 'advanced' THEN 3 WHEN 'intermediate' THEN 2 WHEN 'beginner' THEN 1 ELSE 0 END
             )::numeric / 3 * 100)::int AS avg_level_pct
      FROM user_skills us
      JOIN skills s ON s.id = us.skill_id
      WHERE ${orgScope('us', scope)}
      GROUP BY COALESCE(s.domain, 'General')
      ORDER BY learners DESC
    `);
  }
}
