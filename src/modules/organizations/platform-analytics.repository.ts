import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

/**
 * Cross-org aggregates, one row per organization.
 *
 * DELIBERATELY UNSCOPED — the third and last file the audit grep in spec §4.3
 * / acceptance criterion 6 (every repository method touching a tenant-owned
 * table takes an org scope, checked across `src/modules/*\/*.repository.ts`)
 * is expected to miss, alongside `auth.repository.ts` and
 * `organizations.repository.ts`. A platform-wide rollup has no single
 * organization to scope to by definition — that is the entire point of this
 * file existing, and `@PlatformAdmin()` on every controller that calls it is
 * what keeps an org admin from ever reaching it.
 *
 * Written as set-based `GROUP BY organization_id` aggregates joined into ONE
 * query, never the per-learner correlated-subquery shape from
 * `certificates.repository.ts` / `analytics.repository.ts` reused across
 * orgs — measured at 851 ms platform-wide vs. 36 ms for this shape at 12 orgs
 * (spec §3.8). One round trip regardless of how many organizations exist.
 */
@Injectable()
export class PlatformAnalyticsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** All organizations, each with its own counts. */
  async listOrganizationStats(): Promise<OrganizationStatsRow[]> {
    return this.db.all<OrganizationStatsRow>(this.statsQuery(sql``));
  }

  /** One organization's counts, filtered inside the same single-query shape. */
  async getOrganizationStatsById(
    id: number,
  ): Promise<OrganizationStatsRow | null> {
    const rows = await this.db.all<OrganizationStatsRow>(
      this.statsQuery(sql`WHERE o.id = ${id}`),
    );
    return rows[0] ?? null;
  }

  /**
   * Every count the platform board and the org detail view need, joined onto
   * `organizations` in one statement so adding a second org never costs a
   * second round trip.
   *
   * `learners`/`admins` come from the identity table `users` (its own org);
   * `courses` and `sessions` from content/session tables (their owner's org —
   * a global course groups under the platform organization's own row, which
   * is correct: it IS platform-owned content); `completions` and the video
   * half of the minutes sources are activity tables and already carry the learner's org
   * directly, with no join needed to reach it (spec §3.3).
   *
   * `minutes` intentionally counts the same two lesson-side sources as
   * `LearningHoursRepository.lessonSource` (measured watch time for video,
   * declared `duration_minutes` for everything else on completion) and
   * excludes SCORM: `scorm_tracking.total_time` is stored as a
   * driver-specific formatted string (SCORM 1.2 `HHHH:MM:SS.SS`, 2004 an ISO
   * 8601 duration) that only `LearningHoursService` parses, in JavaScript, per
   * learner. Summing it across every org in one SQL statement would mean
   * re-implementing that parser as a Postgres expression — a real cost for a
   * platform-wide approximation. This total is therefore a documented
   * deliberate divergence from the canonical figure `modules/learning-hours`
   * already gives each org's own admin.
   */
  private statsQuery(filter: SQL): SQL {
    return sql`
      WITH learner_counts AS (
        SELECT organization_id, COUNT(*) AS learners
        FROM users
        WHERE role = 'learner' AND is_active = 1
        GROUP BY organization_id
      ),
      admin_counts AS (
        SELECT organization_id, COUNT(*) AS admins
        FROM users
        WHERE role = 'admin' AND is_active = 1
        GROUP BY organization_id
      ),
      course_counts AS (
        SELECT organization_id, COUNT(*) AS courses
        FROM courses
        WHERE is_active = 1
        GROUP BY organization_id
      ),
      session_counts AS (
        SELECT organization_id, COUNT(*) AS sessions
        FROM sessions
        GROUP BY organization_id
      ),
      completion_counts AS (
        SELECT organization_id, COUNT(*) AS completions
        FROM user_lesson_completions
        GROUP BY organization_id
      ),
      hours AS (
        SELECT organization_id, COALESCE(SUM(minutes), 0) AS minutes
        FROM (
          SELECT vp.organization_id AS organization_id,
                 vp.watched_seconds / 60.0 AS minutes
          FROM lesson_video_progress vp
          JOIN lessons l ON l.id = vp.lesson_id
          WHERE l.content_type <> 'scorm'

          UNION ALL

          SELECT c.organization_id AS organization_id,
                 COALESCE(l.duration_minutes, 0) AS minutes
          FROM user_lesson_completions c
          JOIN lessons l ON l.id = c.lesson_id
          WHERE l.content_type <> 'scorm'
            AND NOT EXISTS (
              SELECT 1 FROM lesson_video_progress vp
              WHERE vp.user_id = c.user_id AND vp.lesson_id = c.lesson_id
            )
        ) source
        GROUP BY organization_id
      )
      SELECT
        o.id         AS organization_id,
        o.name       AS name,
        o.slug       AS slug,
        o.logo_url   AS logo_url,
        o.is_platform AS is_platform,
        o.is_active  AS is_active,
        o.created_at AS created_at,
        COALESCE(lc.learners, 0)      AS learners,
        COALESCE(ac.admins, 0)        AS admins,
        COALESCE(cc.courses, 0)       AS courses,
        COALESCE(sc.sessions, 0)      AS sessions,
        COALESCE(comp.completions, 0) AS completions,
        COALESCE(h.minutes, 0)        AS minutes
      FROM organizations o
      LEFT JOIN learner_counts    lc   ON lc.organization_id = o.id
      LEFT JOIN admin_counts      ac   ON ac.organization_id = o.id
      LEFT JOIN course_counts     cc   ON cc.organization_id = o.id
      LEFT JOIN session_counts    sc   ON sc.organization_id = o.id
      LEFT JOIN completion_counts comp ON comp.organization_id = o.id
      LEFT JOIN hours             h    ON h.organization_id = o.id
      ${filter}
      ORDER BY o.id
    `;
  }
}

export interface OrganizationStatsRow {
  organization_id: number;
  name: string;
  slug: string;
  logo_url: string | null;
  is_platform: boolean;
  is_active: number;
  created_at: string;
  learners: number;
  admins: number;
  courses: number;
  sessions: number;
  completions: number;
  minutes: number;
}
