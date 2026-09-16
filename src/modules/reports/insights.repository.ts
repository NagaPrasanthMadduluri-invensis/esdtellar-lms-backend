import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

/**
 * Queries behind the admin Analytics page and the Reports builder.
 *
 * Separate from `AnalyticsRepository` on purpose. That one answers "what is
 * true right now" with a single per-learner aggregate every endpoint reuses.
 * Everything here is either **bucketed by time** or **filtered by a caller's
 * report spec**, and folding those into the same row shape would have meant a
 * per-learner aggregate carrying eighteen months of columns.
 *
 * HOURS ARE NOT COMPUTED HERE. Every minutes figure on the Analytics page
 * comes from `LearningHoursService` (§10.4 — one definition, and this module
 * reaches it through the service, never its repository). What lives here is
 * counts, rates, scores and attendance.
 */

export interface PeriodCountRow {
  period: string;
  n: number;
}

export interface LearnerFlowRow {
  period: string;
  joined: number;
  active: number;
}

export interface CompletionFilterRow {
  user_id: number;
  first_name: string;
  last_name: string;
  department: string | null;
  location: string | null;
  job_role: string | null;
  job_level: string | null;
  course_id: number;
  course_name: string;
  assigned_at: string;
  total_lessons: number;
  completed_lessons: number;
  last_completed_at: string | null;
  best_score: number | null;
}

export interface AttemptFilterRow {
  user_id: number;
  first_name: string;
  last_name: string;
  department: string | null;
  location: string | null;
  job_role: string | null;
  job_level: string | null;
  course_name: string;
  assessment_title: string;
  percentage: number;
  is_passed: number;
  submitted_at: string;
}

export interface AttendanceRow {
  session_id: number;
  title: string;
  trainer: string | null;
  date: string;
  enrolled: number;
  present: number;
}

/** A learner-shaped filter, as the Reports builder supplies it. */
export interface AudienceFilter {
  department?: string | null;
  location?: string | null;
  jobRole?: string | null;
  jobLevel?: string | null;
}

/** An inclusive date window. Both ends are ISO dates (YYYY-MM-DD). */
export interface Window {
  from: string;
  to: string;
}

const TRUNC_UNITS = ['month', 'quarter', 'year'] as const;
export type TruncUnit = (typeof TRUNC_UNITS)[number];

/**
 * `date_trunc` takes its unit as a string, so a caller-supplied value there is
 * an injection point even when every call site passes a literal. Rejecting
 * loudly is the same posture `orgScope()` takes with a table alias.
 */
function truncUnit(unit: string): TruncUnit {
  if (!(TRUNC_UNITS as readonly string[]).includes(unit)) {
    throw new Error(`"${unit}" is not an allowed date_trunc unit`);
  }
  return unit as TruncUnit;
}

@Injectable()
export class InsightsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * The audience predicate, written once.
   *
   * Every filter is an equality on a `users` column, and every one of them is
   * OPTIONAL — an omitted filter must widen the report, not narrow it to rows
   * where the column is null. `IS NULL OR =` in a single fragment is what
   * keeps that true for all four without four branches at each call site.
   */
  private audience(alias: string, f: AudienceFilter): SQL {
    const a = sql.identifier(alias);
    return sql`
      (${f.department ?? null}::text IS NULL OR ${a}.department = ${f.department ?? null})
      AND (${f.location ?? null}::text IS NULL OR ${a}.location = ${f.location ?? null})
      AND (${f.jobRole ?? null}::text IS NULL OR ${a}.job_role = ${f.jobRole ?? null})
      AND (${f.jobLevel ?? null}::text IS NULL OR ${a}.job_level = ${f.jobLevel ?? null})
    `;
  }

  // ───────────────────────── Analytics: time series ─────────────────────

  /** Earliest and latest activity, so the period axis matches the real data. */
  async activityExtent(scope: OrgScope): Promise<{ first: string | null; last: string | null }> {
    const rows = await this.db.all<{ first: string | null; last: string | null }>(sql`
      SELECT MIN(at)::date::text AS first, MAX(at)::date::text AS last
      FROM (
        SELECT assigned_at AS at FROM user_course_assignments WHERE ${orgScope('user_course_assignments', scope)}
        UNION ALL
        SELECT completed_at FROM user_lesson_completions WHERE ${orgScope('user_lesson_completions', scope)}
        UNION ALL
        SELECT submitted_at FROM user_assessment_attempts WHERE ${orgScope('user_assessment_attempts', scope)}
      ) t
    `);
    return rows[0] ?? { first: null, last: null };
  }

  /** Enrolments per period. */
  async enrollmentsByPeriod(scope: OrgScope, unit: TruncUnit): Promise<PeriodCountRow[]> {
    const u = truncUnit(unit);
    return this.db.all<PeriodCountRow>(sql`
      SELECT date_trunc(${u}, assigned_at)::date::text AS period, COUNT(*)::int AS n
      FROM user_course_assignments
      WHERE ${orgScope('user_course_assignments', scope)}
      GROUP BY 1 ORDER BY 1
    `);
  }

  /**
   * COURSE completions per period — not lesson completions.
   *
   * A course counts in the period its LAST lesson was finished, which is the
   * only date at which the course became complete. Counting lesson rows
   * instead would make a 20-lesson course twenty times more significant than a
   * 1-lesson one on a chart labelled "completions".
   */
  async courseCompletionsByPeriod(scope: OrgScope, unit: TruncUnit): Promise<PeriodCountRow[]> {
    const u = truncUnit(unit);
    return this.db.all<PeriodCountRow>(sql`
      WITH per_course AS (
        SELECT uca.user_id,
               uca.course_id,
               COUNT(DISTINCT l.id) AS total,
               COUNT(DISTINCT ulc.lesson_id) AS done,
               MAX(ulc.completed_at) AS finished_at
        FROM user_course_assignments uca
        JOIN course_modules cm ON cm.course_id = uca.course_id
        JOIN lessons l ON l.module_id = cm.id
        LEFT JOIN user_lesson_completions ulc
          ON ulc.lesson_id = l.id AND ulc.user_id = uca.user_id
        WHERE ${orgScope('uca', scope)}
        GROUP BY uca.user_id, uca.course_id
      )
      SELECT date_trunc(${u}, finished_at)::date::text AS period, COUNT(*)::int AS n
      FROM per_course
      WHERE total > 0 AND done >= total AND finished_at IS NOT NULL
      GROUP BY 1 ORDER BY 1
    `);
  }

  /**
   * Learners joined, and learners active, per period.
   *
   * "Active" is *did something in this period*, not *has an active account* —
   * the two are different questions and the dashboard's own learner count
   * already answers the second one.
   */
  async learnerFlowByPeriod(scope: OrgScope, unit: TruncUnit): Promise<LearnerFlowRow[]> {
    const u = truncUnit(unit);
    return this.db.all<LearnerFlowRow>(sql`
      WITH joined AS (
        SELECT date_trunc(${u}, created_at)::date AS period, COUNT(*)::int AS n
        FROM users
        WHERE role = 'learner' AND ${orgScope('users', scope)}
        GROUP BY 1
      ),
      active AS (
        SELECT date_trunc(${u}, completed_at)::date AS period,
               COUNT(DISTINCT user_id)::int AS n
        FROM user_lesson_completions
        WHERE ${orgScope('user_lesson_completions', scope)}
        GROUP BY 1
      )
      SELECT COALESCE(j.period, a.period)::text AS period,
             COALESCE(j.n, 0) AS joined,
             COALESCE(a.n, 0) AS active
      FROM joined j
      FULL OUTER JOIN active a ON a.period = j.period
      ORDER BY 1
    `);
  }

  /** Certificates issued per period — excludes revoked, which are not an award. */
  async certificatesByPeriod(scope: OrgScope, unit: TruncUnit): Promise<PeriodCountRow[]> {
    const u = truncUnit(unit);
    return this.db.all<PeriodCountRow>(sql`
      SELECT date_trunc(${u}, issued_at)::date::text AS period, COUNT(*)::int AS n
      FROM certificates
      WHERE is_revoked = 0 AND ${orgScope('certificates', scope)}
      GROUP BY 1 ORDER BY 1
    `);
  }

  /** Per-learner engagement table at the foot of the Analytics page. */
  async learnerEngagement(scope: OrgScope) {
    return this.db.all<{
      id: number;
      first_name: string;
      last_name: string;
      department: string | null;
      job_level: string | null;
      location: string | null;
    }>(sql`
      SELECT u.id, u.first_name, u.last_name, u.department, u.job_level, u.location
      FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1 AND ${orgScope('u', scope)}
      ORDER BY u.first_name, u.last_name
    `);
  }

  // ───────────────────────── Reports builder ────────────────────────────

  /**
   * One row per (learner, course) assignment, with its progress and best
   * score, filtered by audience.
   *
   * This single query backs the Course Completion report, the completion
   * metric in a Comparison, and the course table in an Individual report. It
   * is the N+1 the legacy code kept re-introducing (§7.1): assignments, then
   * a lesson count per row, then a score per row.
   */
  async assignmentsFiltered(
    scope: OrgScope,
    filter: AudienceFilter,
    userId?: number,
  ): Promise<CompletionFilterRow[]> {
    return this.db.all<CompletionFilterRow>(sql`
      SELECT u.id AS user_id, u.first_name, u.last_name,
             u.department, u.location, u.job_role, u.job_level,
             c.id AS course_id, c.name AS course_name,
             uca.assigned_at::text AS assigned_at,
             (SELECT COUNT(*)::int FROM course_modules cm
                JOIN lessons l ON l.module_id = cm.id
               WHERE cm.course_id = c.id) AS total_lessons,
             (SELECT COUNT(*)::int FROM course_modules cm
                JOIN lessons l ON l.module_id = cm.id
                JOIN user_lesson_completions ulc
                  ON ulc.lesson_id = l.id AND ulc.user_id = u.id
               WHERE cm.course_id = c.id) AS completed_lessons,
             (SELECT MAX(ulc.completed_at)::text FROM course_modules cm
                JOIN lessons l ON l.module_id = cm.id
                JOIN user_lesson_completions ulc
                  ON ulc.lesson_id = l.id AND ulc.user_id = u.id
               WHERE cm.course_id = c.id) AS last_completed_at,
             (SELECT MAX(t.percentage) FROM user_assessment_attempts t
                JOIN assessments a ON a.id = t.assessment_id
               WHERE t.user_id = u.id AND a.course_id = c.id) AS best_score
      FROM user_course_assignments uca
      JOIN users u ON u.id = uca.user_id
      JOIN courses c ON c.id = uca.course_id
      WHERE ${orgScope('uca', scope)}
        AND u.role = 'learner'
        AND (${userId ?? null}::int IS NULL OR u.id = ${userId ?? null})
        AND ${this.audience('u', filter)}
      ORDER BY u.first_name, u.last_name, c.name
    `);
  }

  /** Every scored attempt, filtered by audience. Backs the Assessment report. */
  async attemptsFiltered(
    scope: OrgScope,
    filter: AudienceFilter,
    userId?: number,
  ): Promise<AttemptFilterRow[]> {
    return this.db.all<AttemptFilterRow>(sql`
      SELECT u.id AS user_id, u.first_name, u.last_name,
             u.department, u.location, u.job_role, u.job_level,
             c.name AS course_name, a.title AS assessment_title,
             t.percentage, t.is_passed, t.submitted_at::text AS submitted_at
      FROM user_assessment_attempts t
      JOIN users u ON u.id = t.user_id
      JOIN assessments a ON a.id = t.assessment_id
      JOIN courses c ON c.id = a.course_id
      WHERE ${orgScope('t', scope)}
        AND (${userId ?? null}::int IS NULL OR u.id = ${userId ?? null})
        AND ${this.audience('u', filter)}
      ORDER BY t.submitted_at DESC
    `);
  }

  /** Session roster and attendance, per session. Backs two reports. */
  async attendanceBySession(scope: OrgScope, window: Window): Promise<AttendanceRow[]> {
    return this.db.all<AttendanceRow>(sql`
      SELECT s.id AS session_id, s.title, s.trainer, s.date::text AS date,
             COUNT(DISTINCT sr.user_id)::int AS enrolled,
             COUNT(DISTINCT CASE
               WHEN sa.status IN ('present', 'late', 'partial') THEN sa.user_id
             END)::int AS present
      FROM sessions s
      LEFT JOIN session_roster sr ON sr.session_id = s.id
      LEFT JOIN session_attendance sa ON sa.session_id = s.id AND sa.user_id = sr.user_id
      WHERE ${orgScope('s', scope)}
        AND s.date::date BETWEEN ${window.from}::date AND ${window.to}::date
      GROUP BY s.id, s.title, s.trainer, s.date
      ORDER BY s.date DESC
    `);
  }

  /** Every learner in the org, filtered by audience — the Learning Hours report. */
  async learnersFiltered(scope: OrgScope, filter: AudienceFilter, userId?: number) {
    return this.db.all<{
      id: number;
      first_name: string;
      last_name: string;
      email: string;
      department: string | null;
      location: string | null;
      job_role: string | null;
      job_level: string | null;
    }>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email,
             u.department, u.location, u.job_role, u.job_level
      FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1 AND ${orgScope('u', scope)}
        AND (${userId ?? null}::int IS NULL OR u.id = ${userId ?? null})
        AND ${this.audience('u', filter)}
      ORDER BY u.first_name, u.last_name
    `);
  }

  /** The distinct values each Reports filter can offer, from live data. */
  async filterOptions(scope: OrgScope) {
    return this.db.all<{ kind: string; value: string }>(sql`
      SELECT 'department' AS kind, department AS value FROM users
        WHERE role = 'learner' AND department IS NOT NULL AND ${orgScope('users', scope)}
      UNION
      SELECT 'location', location FROM users
        WHERE role = 'learner' AND location IS NOT NULL AND ${orgScope('users', scope)}
      UNION
      SELECT 'jobRole', job_role FROM users
        WHERE role = 'learner' AND job_role IS NOT NULL AND ${orgScope('users', scope)}
      UNION
      SELECT 'jobLevel', job_level FROM users
        WHERE role = 'learner' AND job_level IS NOT NULL AND ${orgScope('users', scope)}
      ORDER BY 1, 2
    `);
  }

  // ───────────────────────── Dashboard extras ───────────────────────────

  /**
   * Learners who need chasing: assigned and never started, or stalled partway
   * for more than `staleDays`.
   *
   * Computed in SQL rather than by filtering the per-learner aggregate in
   * Node, because "stalled" needs the last completion date per assignment and
   * that is not on the aggregate (§7.2).
   */
  async actionRequired(scope: OrgScope, staleDays: number) {
    return this.db.all<{
      user_id: number;
      first_name: string;
      last_name: string;
      department: string | null;
      course_id: number;
      course_name: string;
      total_lessons: number;
      completed_lessons: number;
      last_activity: string | null;
      assigned_at: string;
      best_score: number | null;
      passing_score: number | null;
    }>(sql`
      WITH progress AS (
        SELECT u.id AS user_id, u.first_name, u.last_name, u.department,
               c.id AS course_id, c.name AS course_name,
               uca.assigned_at::text AS assigned_at,
               (SELECT COUNT(*)::int FROM course_modules cm
                  JOIN lessons l ON l.module_id = cm.id
                 WHERE cm.course_id = c.id) AS total_lessons,
               (SELECT COUNT(*)::int FROM course_modules cm
                  JOIN lessons l ON l.module_id = cm.id
                  JOIN user_lesson_completions ulc
                    ON ulc.lesson_id = l.id AND ulc.user_id = u.id
                 WHERE cm.course_id = c.id) AS completed_lessons,
               (SELECT MAX(ulc.completed_at)::text FROM course_modules cm
                  JOIN lessons l ON l.module_id = cm.id
                  JOIN user_lesson_completions ulc
                    ON ulc.lesson_id = l.id AND ulc.user_id = u.id
                 WHERE cm.course_id = c.id) AS last_activity,
               (SELECT MAX(t.percentage) FROM user_assessment_attempts t
                  JOIN assessments a ON a.id = t.assessment_id
                 WHERE t.user_id = u.id AND a.course_id = c.id) AS best_score,
               (SELECT MIN(a.passing_score) FROM assessments a
                 WHERE a.course_id = c.id) AS passing_score
        FROM user_course_assignments uca
        JOIN users u ON u.id = uca.user_id
        JOIN courses c ON c.id = uca.course_id
        WHERE ${orgScope('uca', scope)} AND u.role = 'learner' AND u.is_active = 1
      )
      SELECT * FROM progress
      WHERE total_lessons > 0
        AND (
          completed_lessons = 0
          OR (completed_lessons < total_lessons
              AND last_activity IS NOT NULL
              AND last_activity::timestamptz < now() - (${staleDays} || ' days')::interval)
          OR (best_score IS NOT NULL AND best_score < COALESCE(passing_score, 60))
        )
      ORDER BY completed_lessons ASC, assigned_at ASC
      LIMIT 25
    `);
  }
}
