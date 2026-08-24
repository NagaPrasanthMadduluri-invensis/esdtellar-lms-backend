import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

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
  private get lessonSource() {
    return sql`
      SELECT vp.user_id,
             cm.course_id,
             vp.watched_seconds / 60.0 AS minutes,
             vp.updated_at AS at
      FROM lesson_video_progress vp
      JOIN lessons l ON l.id = vp.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.content_type <> 'scorm'

      UNION ALL

      SELECT c.user_id,
             cm.course_id,
             COALESCE(l.duration_minutes, 0) AS minutes,
             c.completed_at AS at
      FROM user_lesson_completions c
      JOIN lessons l ON l.id = c.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.content_type <> 'scorm'
        AND NOT EXISTS (
          SELECT 1 FROM lesson_video_progress vp
          WHERE vp.user_id = c.user_id AND vp.lesson_id = c.lesson_id
        )
    `;
  }

  /**
   * The canonical lesson-side minutes query.
   *
   * Exactly one source counts per lesson, which is what stops the same sitting
   * being paid for twice:
   *
   *   video with a progress row  -> measured watch time, declared value ignored
   *   SCORM lesson               -> excluded here entirely, counted from
   *                                 scorm_tracking instead (it reports its own
   *                                 time, and marking the lesson complete would
   *                                 otherwise ALSO credit duration_minutes)
   *   anything else completed    -> the admin-declared duration_minutes
   *
   * The union is grouped once by user so this stays a single round trip
   * regardless of how many learners or lessons exist.
   */
  async minutesByUser(
    thisMonth: string,
    lastMonth: string,
    weeks: readonly Week[],
  ): Promise<MinutesRow[]> {
    const [w1, w2, w3, w4] = weeks;
    return this.db.all<MinutesRow>(sql`
      WITH source AS (${this.lessonSource})
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
      WHERE u.role = 'learner'
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
  async lessonMinutesByCourse(): Promise<CourseMinutesRow[]> {
    return this.db.all<CourseMinutesRow>(sql`
      WITH source AS (${this.lessonSource})
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
  async scormTimesByCourse(): Promise<CourseScormTimeRow[]> {
    return this.db.all<CourseScormTimeRow>(sql`
      SELECT st.user_id, cm.course_id, MAX(st.total_time) AS total_time
      FROM scorm_tracking st
      JOIN lessons l ON l.scorm_package_id = st.package_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE st.total_time IS NOT NULL
        AND l.is_active = 1 AND cm.is_active = 1
      GROUP BY st.user_id, cm.course_id, st.package_id
    `);
  }

  /**
   * SCORM time is stored as a string the database cannot sum — SCORM 1.2 uses
   * `HHHH:MM:SS.SS` and 2004 uses an ISO 8601 duration — so the rows come back
   * raw and are parsed in the service.
   */
  async scormTimes(): Promise<ScormTimeRow[]> {
    return this.db.all<ScormTimeRow>(sql`
      SELECT user_id, total_time, updated_at
      FROM scorm_tracking
      WHERE total_time IS NOT NULL
    `);
  }
}
