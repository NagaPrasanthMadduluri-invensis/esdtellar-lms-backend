import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import {
  contentScope,
  orgScope,
  type OrgScope,
} from '@/database/org-scope';

export interface LearnerProfileRow {
  job_role: string | null;
  job_level: string | null;
}

export interface RecommendableCourseRow {
  name: string;
  category: string | null;
  skills: string[];
}

/**
 * The only new reads the learner AI vertical needs (spec ai-insights.md Wave 2).
 *
 * Everything else in the feature context comes from the canonical services
 * (LearnerService, LeaderboardService, BadgesService, CompetenciesService,
 * SurveysService) so there is no second definition of completion, hours or
 * points. This repository owns just two things nobody else answers: the
 * learner's professional attributes, and the courses worth recommending.
 */
@Injectable()
export class LearnerInsightsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * The learner's own job role and level — professional attributes that drive
   * role-based suggestions. `department` is deliberately NOT selected: it is an
   * indirect identifier the recommendation prompt does not use (§10.54 PII rule).
   */
  async learnerProfile(
    scope: OrgScope,
    userId: number,
  ): Promise<LearnerProfileRow | null> {
    const rows = await this.db.all<LearnerProfileRow>(sql`
      SELECT u.job_role, u.job_level
      FROM users u
      WHERE u.id = ${userId} AND ${orgScope('u', scope)}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Active, non-archived courses in this org (own + shared platform content)
   * that the learner has NOT been assigned, with the skills each imparts — the
   * candidate pool the model draws recommendations from.
   *
   * Session companions and external-certification companions are excluded: a
   * learner cannot self-start either (§10.7, §10.26), so recommending one would
   * be advice they cannot act on.
   */
  async recommendableCourses(
    scope: OrgScope,
    userId: number,
    limit: number,
  ): Promise<RecommendableCourseRow[]> {
    return this.db.all<RecommendableCourseRow>(sql`
      SELECT
        c.name,
        c.category,
        COALESCE(
          array_agg(s.name) FILTER (WHERE s.name IS NOT NULL),
          '{}'
        ) AS skills
      FROM courses c
      LEFT JOIN course_skills cs ON cs.course_id = c.id
      LEFT JOIN skills s ON s.id = cs.skill_id AND s.is_active = 1
      WHERE ${contentScope('c', scope)}
        AND c.is_active = 1
        AND c.archived_at IS NULL
        AND c.session_id IS NULL
        AND c.external_certification_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_course_assignments uca
          WHERE uca.course_id = c.id
            AND uca.user_id = ${userId}
            AND ${orgScope('uca', scope)}
        )
      GROUP BY c.id, c.name, c.category
      ORDER BY c.id DESC
      LIMIT ${limit}
    `);
  }
}
