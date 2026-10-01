import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

/** Minutes per learner, split into the periods every hours view needs. */
export interface MinutesRow {
  user_id: number;
  all_time: number;
  this_month: number;
  last_month: number;
  /**
   * The CURRENT week, quarter and year.
   *
   * Added beside the month rather than queried separately because every
   * caller of this method already pays for the scan — the admin dashboard
   * wanted "hours this quarter" next to "hours this month", and a second
   * query for it would be a second definition of an hour (§10.4) for the
   * sake of three more `SUM(CASE …)` branches on a row already being read.
   */
  this_week: number;
  this_quarter: number;
  this_year: number;
  w1: number;
  w2: number;
  w3: number;
  w4: number;
}

export interface ScormTimeRow {
  user_id: number;
  total_time: string | null;
  updated_at: string;
  /** The lesson's declared worth, or the package's. Null when neither says. */
  declared_minutes: number | null;
  /** True when a lesson completion has ALREADY paid the declared duration. */
  credited_by_lesson: boolean;
}

/** Lesson-side minutes for one learner on one course. */
export interface CourseMinutesRow {
  user_id: number;
  course_id: number;
  minutes: number;
}

/** Minutes in one calendar bucket, org-wide. */
export interface PeriodMinutesRow {
  period: string;
  minutes: number;
  learners: number;
}

/** Minutes in one calendar bucket, for one mode of learning. */
export interface PeriodModeMinutesRow {
  period: string;
  mode: string;
  minutes: number;
}

/** Minutes for one learner inside a window, beside their all-time total. */
export interface WindowMinutesRow {
  user_id: number;
  minutes: number;
  all_time: number;
}

/** Minutes for one department, all time. */
export interface DepartmentMinutesRow {
  department: string;
  minutes: number;
  learners: number;
}

/** Minutes in one calendar bucket, for one KIND of learning, one learner. */
export interface PeriodTypeMinutesRow {
  period: string;
  learning_type: string;
  minutes: number;
}

/** SCORM residual for one learner, attributed to a kind and a timestamp. */
export interface TypeScormTimeRow {
  learning_type: string;
  total_time: string | null;
  declared_minutes: number | null;
  credited_by_lesson: boolean;
  updated_at: string;
}

/** SCORM time for one learner on one course, still unparsed. */
export interface CourseScormTimeRow {
  user_id: number;
  course_id: number;
  total_time: string | null;
  /** The lesson's declared worth, or the package's. Null when neither says. */
  declared_minutes: number | null;
  /** True when a lesson completion has ALREADY paid the declared duration. */
  credited_by_lesson: boolean;
}

export interface Week {
  start: string;
  end: string;
}

@Injectable()
export class LearningHoursRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * THE definition of what counts as lesson-side learning time.
   *
   * Written once and interpolated into every query that needs it, so the
   * per-learner totals and the per-course breakdown can never drift apart —
   * which is the whole point of this module existing (§10.4). Emits one row per
   * countable event: `user_id`, `course_id`, `minutes`, and `at` (when it
   * happened, for the monthly and weekly buckets).
   *
   * Exactly one source counts per lesson:
   *
   *   video with a progress row  -> measured watch time, declared value ignored
   *   SCORM lesson               -> excluded here entirely, counted from
   *                                 scorm_tracking instead (it reports its own
   *                                 time, and marking the lesson complete would
   *                                 otherwise ALSO credit duration_minutes)
   *   anything else completed    -> the admin-declared duration_minutes, which
   *                                 for a document is mandatory precisely so
   *                                 this is never silently zero
   */
  /**
   * Scoped ONCE here rather than in every caller — `minutesByUser` and
   * `lessonMinutesByCourse` both interpolate this fragment, and scoping it a
   * second time in each of them is exactly the kind of drift §10.4 exists to
   * prevent. `vp` and `c` (lesson_video_progress / user_lesson_completions)
   * are activity tables, so this is a straight org match — no global-content
   * IN-list, unlike a courses catalogue read.
   *
   * `lesson_id` and `content_type` were ADDED to the fragment rather than
   * queried separately by the analytics breakdowns that needed them. Those
   * breakdowns split the same minutes by period and by mode of learning, and a
   * second hand-written source would be free to disagree with this one about
   * what an hour is — which is the entire failure §10.4 records. Existing
   * consumers name their columns explicitly, so the extra two cost them
   * nothing.
   */
  private lessonSource(scope: OrgScope) {
    return sql`
      SELECT c.user_id,
             cm.course_id,
             l.id AS lesson_id,
             l.content_type,
             COALESCE(l.duration_minutes, 0) AS minutes,
             c.completed_at AS at
      FROM user_lesson_completions c
      JOIN lessons l ON l.id = c.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE ${orgScope('c', scope)}

      UNION ALL

      SELECT vp.user_id,
             cm.course_id,
             l.id AS lesson_id,
             l.content_type,
             LEAST(
               vp.watched_seconds / 60.0,
               COALESCE(l.duration_minutes, vp.watched_seconds / 60.0)
             ) AS minutes,
             vp.updated_at AS at
      FROM lesson_video_progress vp
      JOIN lessons l ON l.id = vp.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE ${orgScope('vp', scope)}
        AND NOT EXISTS (
          SELECT 1 FROM user_lesson_completions c
          WHERE c.user_id = vp.user_id AND c.lesson_id = vp.lesson_id
        )
    `;
  }

  /**
   * The canonical lesson-side minutes query. Spec: BACKEND_STRUCTURE.md §10.4.
   *
   * A lesson is worth its declared `duration_minutes`, and exactly one branch
   * of the union pays for any given lesson:
   *
   *   completed (any content type) -> duration_minutes, full stop. Finishing a
   *                                   30-minute video in five earns 30, and
   *                                   re-watching afterwards earns nothing
   *                                   more, because progress rows are excluded
   *                                   once a completion exists.
   *   video, still incomplete      -> measured watch time, CAPPED at
   *                                   duration_minutes so 45 minutes on a
   *                                   30-minute video cannot earn 45.
   *
   * SCORM lessons are in the first branch like everything else. They used to be
   * excluded here and paid purely from `scorm_tracking.total_time`, which paid
   * nothing at all for a package reporting `PT0S` even when it reported itself
   * complete. The service still adds SCORM time, but only for packages whose
   * lesson is NOT yet complete — see `scormTimes`.
   *
   * The union is grouped once by user so this stays a single round trip
   * regardless of how many learners or lessons exist.
   */
  async minutesByUser(
    scope: OrgScope,
    thisMonth: string,
    lastMonth: string,
    weeks: readonly Week[],
    /**
     * Inclusive start dates for the CURRENT week / quarter / year. Passed in
     * rather than computed with `now()` in SQL, because
     * `REPORTING_REFERENCE_DATE` can pin "today" for a demo and a query that
     * ignored it would disagree with every other figure on the page.
     */
    current: { week: string; quarter: string; year: string } = {
      week: '9999-12-31',
      quarter: '9999-12-31',
      year: '9999-12-31',
    },
  ): Promise<MinutesRow[]> {
    const [w1, w2, w3, w4] = weeks;
    return this.db.all<MinutesRow>(sql`
      WITH source AS (${this.lessonSource(scope)})
      SELECT u.id AS user_id,
        COALESCE(SUM(s.minutes), 0) AS all_time,
        COALESCE(SUM(CASE WHEN to_char(s.at, 'YYYY-MM') = ${thisMonth}
                     THEN s.minutes ELSE 0 END), 0) AS this_month,
        COALESCE(SUM(CASE WHEN to_char(s.at, 'YYYY-MM') = ${lastMonth}
                     THEN s.minutes ELSE 0 END), 0) AS last_month,
        COALESCE(SUM(CASE WHEN s.at::date >= ${current.week}::date
                     THEN s.minutes ELSE 0 END), 0) AS this_week,
        COALESCE(SUM(CASE WHEN s.at::date >= ${current.quarter}::date
                     THEN s.minutes ELSE 0 END), 0) AS this_quarter,
        COALESCE(SUM(CASE WHEN s.at::date >= ${current.year}::date
                     THEN s.minutes ELSE 0 END), 0) AS this_year,
        COALESCE(SUM(CASE WHEN s.at::date BETWEEN ${w1.start} AND ${w1.end}
                     THEN s.minutes ELSE 0 END), 0) AS w1,
        COALESCE(SUM(CASE WHEN s.at::date BETWEEN ${w2.start} AND ${w2.end}
                     THEN s.minutes ELSE 0 END), 0) AS w2,
        COALESCE(SUM(CASE WHEN s.at::date BETWEEN ${w3.start} AND ${w3.end}
                     THEN s.minutes ELSE 0 END), 0) AS w3,
        COALESCE(SUM(CASE WHEN s.at::date BETWEEN ${w4.start} AND ${w4.end}
                     THEN s.minutes ELSE 0 END), 0) AS w4
      FROM users u
      LEFT JOIN source s ON s.user_id = u.id
      WHERE u.role = 'learner' AND ${orgScope('u', scope)}
      GROUP BY u.id
    `);
  }

  /**
   * The same minutes, broken down by course.
   *
   * Built on the identical `lessonSource`, so a learner's per-course figures
   * always sum to their total — a second hand-written query would eventually
   * disagree with the first, which is the failure §10.4 was written after.
   */
  async lessonMinutesByCourse(scope: OrgScope): Promise<CourseMinutesRow[]> {
    return this.db.all<CourseMinutesRow>(sql`
      WITH source AS (${this.lessonSource(scope)})
      SELECT user_id, course_id, COALESCE(SUM(minutes), 0) AS minutes
      FROM source
      GROUP BY user_id, course_id
    `);
  }

  /**
   * SCORM time per course.
   *
   * A package reaches a course by being used in one of its lessons. Grouped by
   * package as well as course so a course that uses the same package in two
   * lessons counts that sitting once — it was one sitting.
   */
  async scormTimesByCourse(scope: OrgScope): Promise<CourseScormTimeRow[]> {
    return this.db.all<CourseScormTimeRow>(sql`
      SELECT st.user_id, cm.course_id, MAX(st.total_time) AS total_time,
             MAX(COALESCE(l.duration_minutes, sp.duration_minutes)) AS declared_minutes,
             BOOL_OR(ulc.user_id IS NOT NULL) AS credited_by_lesson
      FROM scorm_tracking st
      JOIN lessons l ON l.scorm_package_id = st.package_id
      JOIN course_modules cm ON cm.id = l.module_id
      LEFT JOIN scorm_packages sp ON sp.id = st.package_id
      LEFT JOIN user_lesson_completions ulc
        ON ulc.lesson_id = l.id AND ulc.user_id = st.user_id
      WHERE st.total_time IS NOT NULL
        AND l.is_active = 1 AND cm.is_active = 1
        AND ${orgScope('st', scope)}
      GROUP BY st.user_id, cm.course_id, st.package_id
    `);
  }

  /**
   * SCORM time per learner, for packages whose lesson is not yet complete.
   *
   * `total_time` is a string the database cannot sum — SCORM 1.2 uses
   * `HHHH:MM:SS.SS` and 2004 an ISO 8601 duration — so rows come back raw and
   * are parsed in the service, which is also where the cap is applied.
   *
   * `credited_by_lesson` is the important column: once the learner has a
   * completion for the lesson carrying this package, the lesson branch of
   * `lessonSource` has already paid the declared duration, and adding reported
   * time on top would pay the same sitting twice — which is exactly what the
   * old query did. A package in no lesson at all has no completion to check,
   * so it keeps being paid from reported time alone.
   *
   * Grouped by (user, package) so a package used in two lessons is one sitting.
   */
  async scormTimes(scope: OrgScope): Promise<ScormTimeRow[]> {
    return this.db.all<ScormTimeRow>(sql`
      SELECT st.user_id,
             MAX(st.total_time) AS total_time,
             MAX(st.updated_at) AS updated_at,
             MAX(COALESCE(l.duration_minutes, sp.duration_minutes)) AS declared_minutes,
             BOOL_OR(ulc.user_id IS NOT NULL) AS credited_by_lesson
      FROM scorm_tracking st
      LEFT JOIN lessons l
        ON l.scorm_package_id = st.package_id AND l.is_active = 1
      LEFT JOIN scorm_packages sp ON sp.id = st.package_id
      LEFT JOIN user_lesson_completions ulc
        ON ulc.lesson_id = l.id AND ulc.user_id = st.user_id
      WHERE st.total_time IS NOT NULL
        AND ${orgScope('st', scope)}
      GROUP BY st.user_id, st.package_id
    `);
  }

  /**
   * The SAME minutes, bucketed by calendar period — what the admin Analytics
   * page draws its "Learning Hours per period" and "Engagement over time"
   * charts from.
   *
   * Third consumer of `lessonSource`, for the reason the second one exists:
   * writing a period-bucketed sum by hand would be a second definition of an
   * hour of learning, and §10.4 records what happened last time there were
   * two. The learner view, the admin analytics and this chart now all reduce
   * to the same fragment, so they cannot disagree.
   *
   * `unit` is whitelisted rather than interpolated — it reaches `date_trunc`,
   * and a caller-supplied string there is an injection point even though every
   * call site today passes a literal.
   */
  async minutesByPeriod(
    scope: OrgScope,
    unit: TruncUnit,
  ): Promise<PeriodMinutesRow[]> {
    const trunc = assertTruncUnit(unit);
    return this.db.all<PeriodMinutesRow>(sql`
      WITH source AS (${this.lessonSource(scope)})
      SELECT date_trunc(${trunc}, s.at)::date AS period,
             COALESCE(SUM(s.minutes), 0) AS minutes,
             COUNT(DISTINCT s.user_id) AS learners
      FROM source s
      GROUP BY 1
      ORDER BY 1
    `);
  }

  /**
   * The same minutes again, split by MODE OF LEARNING.
   *
   * The mode is derived, not stored. A lesson's `content_type` says what it is
   * — video, scorm, document, quiz — except for `session`, where the delivery
   * mode belongs to the session itself (`sessions.session_type`, ILT or
   * Virtual) and the lesson is only its companion (§10.7). So the CASE reaches
   * through the training course to the session for exactly that one type and
   * takes the lesson's own word for every other.
   */
  async minutesByPeriodAndMode(
    scope: OrgScope,
    unit: TruncUnit,
  ): Promise<PeriodModeMinutesRow[]> {
    const trunc = assertTruncUnit(unit);
    return this.db.all<PeriodModeMinutesRow>(sql`
      WITH source AS (${this.lessonSource(scope)})
      SELECT date_trunc(${trunc}, s.at)::date AS period,
             CASE
               WHEN s.content_type = 'session' AND se.session_type = 'ILT' THEN 'ILT'
               WHEN s.content_type = 'session' THEN 'VILT'
               WHEN s.content_type = 'scorm'    THEN 'eLearning'
               WHEN s.content_type = 'video'    THEN 'Video'
               WHEN s.content_type = 'document' THEN 'Document'
               ELSE 'Assessment'
             END AS mode,
             COALESCE(SUM(s.minutes), 0) AS minutes
      FROM source s
      LEFT JOIN courses co ON co.id = s.course_id
      LEFT JOIN sessions se ON se.id = co.session_id
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
  }

  /**
   * The same minutes again, per learner, inside an arbitrary date window.
   *
   * `minutesByUser` above answers "this month / last month / these four
   * weeks", which is what the learner's own hours page asks. The Reports
   * builder asks "this quarter", "this year", "all time" — arbitrary ends the
   * fixed buckets cannot express. Same fragment, so the two never disagree
   * about a learner whose window happens to be a calendar month.
   */
  async minutesByUserInWindow(
    scope: OrgScope,
    from: string,
    to: string,
  ): Promise<WindowMinutesRow[]> {
    return this.db.all<WindowMinutesRow>(sql`
      WITH source AS (${this.lessonSource(scope)})
      SELECT u.id AS user_id,
             COALESCE(SUM(CASE WHEN s.at::date BETWEEN ${from}::date AND ${to}::date
                          THEN s.minutes ELSE 0 END), 0) AS minutes,
             COALESCE(SUM(s.minutes), 0) AS all_time
      FROM users u
      LEFT JOIN source s ON s.user_id = u.id
      WHERE u.role = 'learner' AND ${orgScope('u', scope)}
      GROUP BY u.id
    `);
  }

  /**
   * WHAT KIND of learning an hour came from, for ONE learner.
   *
   * Three kinds, and they are a PARTITION — every minute lands in exactly one,
   * so the three sum to the learner's total and the stacked chart cannot
   * disagree with the headline above it. The precedence is what guarantees
   * that, and it is stated once here rather than at each call site:
   *
   *   session -> the course is a session's companion training (§10.7)
   *   path    -> the learner's assignment row was written by a journey
   *              (`source_journey_id`, §10.11)
   *   course  -> everything else, including a course an admin assigned
   *              directly and an approved external certification (§10.26)
   *
   * Note the middle one reads the ASSIGNMENT, not the course: a course is not
   * intrinsically "path learning", it is path learning for the learner a
   * journey put it in front of. The same course assigned directly to somebody
   * else is a course for them, which is the honest answer.
   *
   * There is deliberately no `webinar` branch. `sessions.session_type` accepts
   * ILT and Virtual only, so a webinar bucket would be zero by construction —
   * the empty-column failure §10.12 records. The colour is reserved in the
   * palette; the branch goes in the day the enum does.
   */
  private learningTypeExpr() {
    return sql`
      CASE
        WHEN co.session_id IS NOT NULL THEN 'session'
        WHEN uca.source_journey_id IS NOT NULL THEN 'path'
        ELSE 'course'
      END`;
  }

  /**
   * The learner's lesson-side minutes, bucketed by period AND kind.
   *
   * Fourth consumer of `lessonSource`, for the reason the second and third
   * exist: a hand-written per-learner sum would be a second definition of an
   * hour, which is the entire failure §10.4 records. The scope predicate is
   * inside the fragment; `user_id` narrows it to the one learner here.
   */
  async learnerMinutesByPeriodAndType(
    scope: OrgScope,
    userId: number,
    unit: TruncUnit,
  ): Promise<PeriodTypeMinutesRow[]> {
    const trunc = assertTruncUnit(unit);
    return this.db.all<PeriodTypeMinutesRow>(sql`
      WITH source AS (${this.lessonSource(scope)})
      SELECT date_trunc(${trunc}, s.at)::date AS period,
             ${this.learningTypeExpr()} AS learning_type,
             COALESCE(SUM(s.minutes), 0) AS minutes
      FROM source s
      LEFT JOIN courses co ON co.id = s.course_id
      LEFT JOIN user_course_assignments uca
        ON uca.course_id = s.course_id AND uca.user_id = s.user_id
      WHERE s.user_id = ${userId}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
  }

  /**
   * The SCORM residual for one learner, carrying its kind and its timestamp.
   *
   * This exists so the per-kind split ADDS UP to the figure the rest of the
   * product shows. `minutesByUser` is lesson minutes PLUS the reported time of
   * packages no lesson completion has paid for yet; a breakdown built from the
   * lesson half alone would be quietly short of the headline beside it, which
   * is the two-numbers-disagreeing failure §10.12 treats as an alarm.
   *
   * Same three predicates as `scormTimesByCourse` — `credited_by_lesson` is
   * still the important one, and is still applied in the service, because
   * `total_time` is a string in one of two formats that Postgres cannot sum.
   */
  async learnerScormByType(
    scope: OrgScope,
    userId: number,
  ): Promise<TypeScormTimeRow[]> {
    return this.db.all<TypeScormTimeRow>(sql`
      SELECT ${this.learningTypeExpr()} AS learning_type,
             MAX(st.total_time) AS total_time,
             MAX(COALESCE(l.duration_minutes, sp.duration_minutes)) AS declared_minutes,
             BOOL_OR(ulc.user_id IS NOT NULL) AS credited_by_lesson,
             MAX(st.updated_at) AS updated_at
      FROM scorm_tracking st
      LEFT JOIN lessons l
        ON l.scorm_package_id = st.package_id AND l.is_active = 1
      LEFT JOIN course_modules cm ON cm.id = l.module_id
      LEFT JOIN courses co ON co.id = cm.course_id
      LEFT JOIN user_course_assignments uca
        ON uca.course_id = cm.course_id AND uca.user_id = st.user_id
      LEFT JOIN scorm_packages sp ON sp.id = st.package_id
      LEFT JOIN user_lesson_completions ulc
        ON ulc.lesson_id = l.id AND ulc.user_id = st.user_id
      WHERE st.total_time IS NOT NULL
        AND st.user_id = ${userId}
        AND ${orgScope('st', scope)}
      GROUP BY st.package_id, 1
    `);
  }

  /** The same minutes, per department. Powers "Engagement by department". */
  async minutesByDepartment(scope: OrgScope): Promise<DepartmentMinutesRow[]> {
    return this.db.all<DepartmentMinutesRow>(sql`
      WITH source AS (${this.lessonSource(scope)})
      SELECT COALESCE(u.department, 'Unassigned') AS department,
             COALESCE(SUM(s.minutes), 0) AS minutes,
             COUNT(DISTINCT u.id) AS learners
      FROM users u
      LEFT JOIN source s ON s.user_id = u.id
      WHERE u.role = 'learner' AND ${orgScope('u', scope)}
      GROUP BY 1
      ORDER BY 2 DESC
    `);
  }
}

/**
 * Calendar buckets `date_trunc` accepts here. Nothing else is permitted.
 *
 * `week` was added for the learner's own trend, which offers Weekly beside
 * Monthly / Quarterly / Yearly. Postgres weeks are ISO — Monday-first — which
 * matches how the calendars in this product already read a week.
 */
export type TruncUnit = 'week' | 'month' | 'quarter' | 'year';

const TRUNC_UNITS: readonly TruncUnit[] = ['week', 'month', 'quarter', 'year'];

function assertTruncUnit(unit: string): TruncUnit {
  if (!(TRUNC_UNITS as readonly string[]).includes(unit)) {
    throw new Error(`minutesByPeriod: "${unit}" is not an allowed date_trunc unit`);
  }
  return unit as TruncUnit;
}
