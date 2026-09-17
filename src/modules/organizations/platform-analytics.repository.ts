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
      /*
       * The tenant's OWNER -- a real account, read from the users table.
       *
       * NOTE: no backticks anywhere in this literal. It sits inside a tagged
       * template, so one would open a JS substitution and the query would
       * stop compiling -- which is exactly how this comment was first
       * written, and 21 type errors is how it announced itself.
       *
       * The directory card used to print organizations.contact_name/email,
       * free-text columns somebody types in. That is a fine place to record a
       * procurement contact, and a terrible thing to label as who runs the
       * account: nothing checks it, so it goes stale the day the person
       * leaves and reads as fact forever. Who can actually administer this
       * tenant is something the database already knows.
       *
       * r.portal = 'admin' is the right filter, and is NOT the same as
       * users.role = 'admin' -- a trainer's role sits on the trainer portal,
       * so trainers drop out here without being named.
       *
       * DISTINCT ON picks one per org: the seeded is_system admin role is the
       * Owner -- the same derivation listPrivilegedAccounts uses for its
       * level column, so there is one definition and not two -- then oldest
       * account first, so the answer is stable between reads.
       */
      owner_admin AS (
        SELECT DISTINCT ON (u.organization_id)
               u.organization_id,
               TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, ''))
                                          AS admin_name,
               u.email                    AS admin_email,
               (r.is_system AND r.key = 'admin')
                                          AS admin_is_owner,
               -- How many admin-portal accounts this tenant has, counted over
               -- the SAME filter that chose the name above. admin_counts uses
               -- users.role instead; the two agree today and are kept in step
               -- by the seed, but the card prints "+N more" right beside this
               -- name and those two figures must not be able to disagree.
               COUNT(*) OVER (PARTITION BY u.organization_id)::int
                                          AS admin_portal_count
          FROM users u
          JOIN roles r ON r.id = u.role_id
         WHERE r.portal = 'admin' AND u.is_active = 1
         ORDER BY u.organization_id,
                  (r.is_system AND r.key = 'admin') DESC,
                  u.created_at,
                  u.id
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
        -- Tenant profile & contract (0026). Selected here rather than in a
        -- second query because every platform screen that shows a count also
        -- shows the account beside it.
        o.industry, o.region,
        o.contact_name, o.contact_email, o.contact_phone,
        -- Who actually administers the tenant, from the users table.
        oa.admin_name, oa.admin_email, oa.admin_is_owner, oa.admin_portal_count,
        o.contract_start, o.contract_end,
        o.contract_value, o.plan, o.billing_cycle, o.notes,
        COALESCE(lc.learners, 0)      AS learners,
        COALESCE(ac.admins, 0)        AS admins,
        COALESCE(cc.courses, 0)       AS courses,
        COALESCE(sc.sessions, 0)      AS sessions,
        COALESCE(comp.completions, 0) AS completions,
        COALESCE(h.minutes, 0)        AS minutes
      FROM organizations o
      LEFT JOIN learner_counts    lc   ON lc.organization_id = o.id
      LEFT JOIN admin_counts      ac   ON ac.organization_id = o.id
      LEFT JOIN owner_admin       oa   ON oa.organization_id = o.id
      LEFT JOIN course_counts     cc   ON cc.organization_id = o.id
      LEFT JOIN session_counts    sc   ON sc.organization_id = o.id
      LEFT JOIN completion_counts comp ON comp.organization_id = o.id
      LEFT JOIN hours             h    ON h.organization_id = o.id
      ${filter}
      ORDER BY o.id
    `;
  }

  /**
   * Every privileged account across every tenant.
   *
   * CROSS-TENANT on purpose, behind `@PlatformAdmin()`. "Privileged" means an
   * ADMIN-PORTAL role — the people who can change a tenant's content, users or
   * settings. Learners, managers and trainers are deliberately out: this page
   * answers "who can act on this account", not "who uses it", and a list of
   * 20,000 learners would bury the four people it is about.
   *
   * `level` is DERIVED from the role, not stored. An organization's seeded
   * `is_system` admin role is its Owner; any other admin-portal role is an
   * Admin. Only those two, because only those two are enforced by anything —
   * the reference's Billing and Auditor levels gate nothing here, and a level
   * that gates nothing is the screen-that-lies failure §5.2.1 exists to
   * prevent.
   *
   * `last_active` is the same GREATEST(completion, attempt) the org user
   * directory uses (§10.12) — one definition of "active", not two.
   */
  async listPrivilegedAccounts(): Promise<PrivilegedAccountRow[]> {
    return this.db.all<PrivilegedAccountRow>(sql`
      SELECT u.id,
             u.first_name, u.last_name, u.email,
             u.is_active,
             u.created_at                       AS granted_at,
             o.id                               AS organization_id,
             o.name                             AS organization_name,
             o.is_platform                      AS is_platform_org,
             r.key                              AS role_key,
             r.label                            AS role_name,
             r.is_system                        AS role_is_system,
             CASE WHEN r.is_system AND r.key = 'admin' THEN 'owner'
                  ELSE 'admin' END              AS level,
             GREATEST(
               (SELECT MAX(c.completed_at) FROM user_lesson_completions c
                 WHERE c.user_id = u.id),
               (SELECT MAX(a.submitted_at) FROM user_assessment_attempts a
                 WHERE a.user_id = u.id)
             )                                  AS last_active
        FROM users u
        JOIN organizations o ON o.id = u.organization_id
        JOIN roles r         ON r.id = u.role_id
       WHERE r.portal = 'admin'
       ORDER BY o.name, level, u.first_name
    `);
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
  /* ── Tenant profile & contract (0026). Nullable throughout — an org
        provisioned before the console existed is still a valid tenant. ── */
  industry: string | null;
  region: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  /* The tenant's real admin account, derived from `users` — never typed in.
     Null only when an organization has no active admin-portal account at all,
     which is itself worth showing rather than papering over. */
  admin_name: string | null;
  admin_email: string | null;
  admin_is_owner: boolean | null;
  admin_portal_count: number | null;
  contract_start: string | null;
  contract_end: string | null;
  /** `numeric` comes back as a STRING from pg — never do maths on it raw. */
  contract_value: string | null;
  plan: string | null;
  billing_cycle: string | null;
  notes: string | null;
  learners: number;
  admins: number;
  courses: number;
  sessions: number;
  completions: number;
  minutes: number;
}

export interface PrivilegedAccountRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  is_active: number;
  granted_at: string;
  organization_id: number;
  organization_name: string;
  is_platform_org: boolean;
  role_key: string;
  role_name: string;
  role_is_system: boolean;
  /** 'owner' | 'admin' — derived from the role, never stored. */
  level: string;
  last_active: string | null;
}
