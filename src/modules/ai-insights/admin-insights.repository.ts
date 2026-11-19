import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

export interface LowRatedRow {
  name: string;
  avg_rating: number;
  responses: number;
}

const MIN_RESPONSES = 3; // §10.20: an average under three responses is withheld.
const LOW_RATING = 3.5;

/**
 * The negative-feedback signal for the admin AI vertical (spec ai-insights.md
 * Wave 3). Everything else in the org context is reused from
 * `AnalyticsService.dashboard` (the one org aggregate); these two reads are the
 * only ones it does not already answer.
 *
 * Both are AGGREGATES only — ratings and counts, never the free-text comments.
 * Comments are learner-written and could identify an opinion, so they are not
 * sent to the model; the admin reads those on the feedback screens, where the
 * audience is controlled.
 */
@Injectable()
export class AdminInsightsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Courses whose average OVERALL rating is low. The overall rating is the
   * template's first `rating` question (§10.24's definition), read from the
   * jsonb answers by that question's id; a `^[1-5]$` guard keeps the cast safe.
   */
  async lowRatedCourses(scope: OrgScope): Promise<LowRatedRow[]> {
    return this.db.all<LowRatedRow>(sql`
      SELECT c.name,
             ROUND(AVG((cf.answers ->> q.qid)::numeric), 1) AS avg_rating,
             COUNT(*)::int AS responses
      FROM course_feedback cf
      JOIN courses c ON c.id = cf.course_id
      JOIN LATERAL (
        SELECT ftq.id::text AS qid
        FROM feedback_template_questions ftq
        WHERE ftq.template_id = cf.template_id AND ftq.question_type = 'rating'
        ORDER BY ftq.sort_order
        LIMIT 1
      ) q ON true
      WHERE ${orgScope('cf', scope)}
        AND (cf.answers ->> q.qid) ~ '^[1-5]$'
      GROUP BY c.id, c.name
      HAVING COUNT(*) >= ${MIN_RESPONSES} AND AVG((cf.answers ->> q.qid)::numeric) < ${LOW_RATING}
      ORDER BY avg_rating ASC
      LIMIT 10
    `);
  }

  /**
   * Sessions whose average of the three ratings (content, trainer, delivery) is
   * low. Clean integer columns, so no jsonb extraction.
   */
  async lowRatedSessions(scope: OrgScope): Promise<LowRatedRow[]> {
    return this.db.all<LowRatedRow>(sql`
      SELECT s.title AS name,
             ROUND(AVG((sf.rating_content + sf.rating_trainer + sf.rating_delivery) / 3.0)::numeric, 1) AS avg_rating,
             COUNT(*)::int AS responses
      FROM session_feedback sf
      JOIN sessions s ON s.id = sf.session_id
      WHERE ${orgScope('sf', scope)}
      GROUP BY s.id, s.title
      HAVING COUNT(*) >= ${MIN_RESPONSES}
         AND AVG((sf.rating_content + sf.rating_trainer + sf.rating_delivery) / 3.0) < ${LOW_RATING}
      ORDER BY avg_rating ASC
      LIMIT 10
    `);
  }
}
