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
   */
  private lessonSource(scope: OrgScope) {
    return sql`
      SELECT c.user_id,
             cm.course_id,
             COALESCE(l.duration_minutes, 0) AS minutes,
             c.completed_at AS at
      FROM user_lesson_completions c
      JOIN lessons l ON l.id = c.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE ${orgScope('c', scope)}

      UNION ALL

      SELECT vp.user_id,
             cm.course_id,
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
}
