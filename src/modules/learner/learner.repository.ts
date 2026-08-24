import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { userCourseAssignments, userLessonCompletions, users } from '@/database/schema';

import { lastMonth, thisMonth, weeks } from './learner.constants';

export interface LearnerPointsRow {
  id: number;
  first_name: string;
  last_name: string;
  department: string | null;
  lessons: number;
  lessons_month: number;
  passed: number;
  passed_month: number;
  avg_score: number | null;
  courses_month: number;
}

export interface LessonMinutesRow {
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

@Injectable()
export class LearnerRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /* ─────────────────────────────────────────────
     Shared aggregates — one query each, for ALL learners.

     These replace the legacy per-learner loops: the leaderboard ran six
     queries per learner (114 round trips for 19 learners), the dashboard and
     achievements each ran two per learner just to compute a rank, and the
     learner learning-hours page ran a query per learner PER WEEK.
  ───────────────────────────────────────────── */

  /** Lesson minutes per learner, bucketed by period — one query, seven buckets. */
  async lessonMinutesByPeriod(): Promise<LessonMinutesRow[]> {
    const [w1, w2, w3, w4] = weeks();
    return this.db.all<LessonMinutesRow>(sql`
      SELECT u.id AS user_id,
        COALESCE(SUM(l.duration_minutes), 0) AS all_time,
        COALESCE(SUM(CASE WHEN to_char(c.completed_at, 'YYYY-MM') = ${thisMonth()}
                     THEN l.duration_minutes ELSE 0 END), 0) AS this_month,
        COALESCE(SUM(CASE WHEN to_char(c.completed_at, 'YYYY-MM') = ${lastMonth()}
                     THEN l.duration_minutes ELSE 0 END), 0) AS last_month,
        COALESCE(SUM(CASE WHEN c.completed_at::date BETWEEN ${w1.start} AND ${w1.end}
                     THEN l.duration_minutes ELSE 0 END), 0) AS w1,
        COALESCE(SUM(CASE WHEN c.completed_at::date BETWEEN ${w2.start} AND ${w2.end}
                     THEN l.duration_minutes ELSE 0 END), 0) AS w2,
        COALESCE(SUM(CASE WHEN c.completed_at::date BETWEEN ${w3.start} AND ${w3.end}
                     THEN l.duration_minutes ELSE 0 END), 0) AS w3,
        COALESCE(SUM(CASE WHEN c.completed_at::date BETWEEN ${w4.start} AND ${w4.end}
                     THEN l.duration_minutes ELSE 0 END), 0) AS w4
      FROM users u
      LEFT JOIN user_lesson_completions c ON c.user_id = u.id
      LEFT JOIN lessons l ON l.id = c.lesson_id
      WHERE u.role = 'learner'
      GROUP BY u.id
    `);
  }

  /**
   * All SCORM tracking rows. `total_time` is an ISO 8601 duration string, so it
   * cannot be summed in SQL — one query fetches the rows and the service
   * buckets them, rather than querying per learner per period.
   */
  async scormTimes(): Promise<ScormTimeRow[]> {
    return this.db.all<ScormTimeRow>(sql`
      SELECT user_id, total_time, updated_at
      FROM scorm_tracking
      WHERE total_time IS NOT NULL
    `);
  }

  async allLearnerProfiles() {
    return this.db.all<{
      id: number;
      first_name: string;
      last_name: string;
      department: string | null;
    }>(sql`
      SELECT id, first_name, last_name, department
      FROM users WHERE role = 'learner'
    `);
  }

  /**
   * The content types each of this learner's courses actually contains.
   *
   * Replaces a hard-coded map that covered course ids 1-4 and asserted things
   * the data contradicted — course 1 was labelled "eLearning / SCORM" while
   * every lesson in it was video, and any course beyond id 4 fell off the map
   * entirely.
   */
  async courseContentTypes(userId: number) {
    return this.db.all<{ course_id: number; content_types: string }>(sql`
      SELECT cm.course_id,
             string_agg(DISTINCT l.content_type, ',') AS content_types
      FROM user_course_assignments uca
      JOIN course_modules cm ON cm.course_id = uca.course_id AND cm.is_active = 1
      JOIN lessons l ON l.module_id = cm.id AND l.is_active = 1
      WHERE uca.user_id = ${userId}
      GROUP BY cm.course_id
    `);
  }

  async findUser(userId: number) {
    const rows = await this.db
      .select({
        id: users.id,
        first_name: users.firstName,
        last_name: users.lastName,
        department: users.department,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /* ─────────────────────────────────────────────
     Course lists
  ───────────────────────────────────────────── */

  /** Assigned courses with lesson counts and last activity — one query. */
  async assignedCourses(userId: number) {
    return this.db.all<{
      enrollment_id: number;
      assigned_at: string;
      course_id: number;
      name: string;
      description: string | null;
      thumbnail_url: string | null;
      total_lessons: number;
      completed_lessons: number;
      completed_minutes: number;
      total_minutes: number;
      last_activity: string | null;
      best_score: number | null;
      passing_score: number | null;
      has_passed: number | null;
      assessment_count: number;
      session_id: number | null;
      session_type: string | null;
      trainer: string | null;
      venue_url: string | null;
      session_department: string | null;
      session_date: string | null;
      session_start_time: string | null;
      session_end_time: string | null;
      session_status: string | null;
    }>(sql`
      SELECT uca.id AS enrollment_id, uca.assigned_at,
        c.id AS course_id, c.name, c.description, c.thumbnail_url,
        c.session_id,
        s.session_type, s.trainer, s.venue_url, s.department AS session_department,
        s.date AS session_date, s.start_time AS session_start_time,
        s.end_time AS session_end_time, s.status AS session_status,
        (SELECT COUNT(*) FROM lessons l
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND l.is_active = 1
           AND cm.is_active = 1) AS total_lessons,
        (SELECT COUNT(*) FROM user_lesson_completions ulc
         JOIN lessons l ON l.id = ulc.lesson_id
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND ulc.user_id = ${userId}) AS completed_lessons,
        (SELECT COALESCE(SUM(l.duration_minutes), 0) FROM user_lesson_completions ulc
         JOIN lessons l ON l.id = ulc.lesson_id
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND ulc.user_id = ${userId}) AS completed_minutes,
        (SELECT COALESCE(SUM(l.duration_minutes), 0) FROM lessons l
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND l.is_active = 1
           AND cm.is_active = 1) AS total_minutes,
        (SELECT MAX(ulc.completed_at) FROM user_lesson_completions ulc
         JOIN lessons l ON l.id = ulc.lesson_id
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND ulc.user_id = ${userId}) AS last_activity,
        (SELECT MAX(t.percentage) FROM user_assessment_attempts t
         JOIN assessments a ON a.id = t.assessment_id
         WHERE a.course_id = c.id AND t.user_id = ${userId}) AS best_score,
        (SELECT MIN(a.passing_score) FROM assessments a
         WHERE a.course_id = c.id AND a.is_active = 1) AS passing_score,
        (SELECT MAX(t.is_passed) FROM user_assessment_attempts t
         JOIN assessments a ON a.id = t.assessment_id
         WHERE a.course_id = c.id AND t.user_id = ${userId}) AS has_passed,
        (SELECT COUNT(*) FROM assessments a
         WHERE a.course_id = c.id AND a.is_active = 1) AS assessment_count
      FROM user_course_assignments uca
      JOIN courses c ON c.id = uca.course_id AND c.is_active = 1
      LEFT JOIN sessions s ON s.id = c.session_id
      WHERE uca.user_id = ${userId}
      ORDER BY uca.assigned_at ASC
    `);
  }

  /* ─────────────────────────────────────────────
     Course detail
  ───────────────────────────────────────────── */

  async isAssigned(userId: number, courseId: number): Promise<boolean> {
    const rows = await this.db
      .select({ id: userCourseAssignments.id })
      .from(userCourseAssignments)
      .where(
        and(
          eq(userCourseAssignments.userId, userId),
          eq(userCourseAssignments.courseId, courseId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async findAssignment(userId: number, courseId: number) {
    const rows = await this.db
      .select()
      .from(userCourseAssignments)
      .where(
        and(
          eq(userCourseAssignments.userId, userId),
          eq(userCourseAssignments.courseId, courseId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveCourse(courseId: number) {
    const rows = await this.db.all(sql`
      SELECT * FROM courses WHERE id = ${courseId} AND is_active = 1
    `);
    return rows[0] ?? null;
  }

  async activeModules(courseId: number) {
    return this.db.all<Record<string, unknown> & { id: number }>(sql`
      SELECT * FROM course_modules
      WHERE course_id = ${courseId} AND is_active = 1
      ORDER BY sort_order, created_at
    `);
  }

  /**
   * Every active lesson in a course with its completion state, in ONE query.
   * A lesson counts as complete via `user_lesson_completions` OR via SCORM
   * tracking (which covers data written before lessons were auto-marked).
   * The legacy handler ran this once per module inside a loop.
   */
  async lessonsWithStatus(courseId: number, userId: number) {
    return this.db.all<Record<string, unknown> & {
      id: number;
      module_id: number;
      progress_status: string;
    }>(sql`
      SELECT l.*,
        CASE
          WHEN ulc.id IS NOT NULL THEN 'completed'
          WHEN (l.content_type = 'scorm' AND l.scorm_package_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM scorm_tracking st
                  WHERE st.package_id = l.scorm_package_id AND st.user_id = ${userId}
                    AND (st.completion_status = 'completed'
                         OR st.lesson_status IN ('passed', 'completed'))
                )) THEN 'completed'
          ELSE 'not_started'
        END AS progress_status
      FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      LEFT JOIN user_lesson_completions ulc
        ON ulc.lesson_id = l.id AND ulc.user_id = ${userId}
      WHERE cm.course_id = ${courseId} AND l.is_active = 1 AND cm.is_active = 1
      ORDER BY cm.sort_order, cm.created_at, l.sort_order, l.created_at
    `);
  }

  async courseAssessments(courseId: number, userId: number) {
    return this.db.all<Record<string, unknown> & { id: number }>(sql`
      SELECT a.*,
        (SELECT COUNT(*) FROM assessment_questions
         WHERE assessment_id = a.id) AS questions_count,
        (SELECT COUNT(*) FROM user_assessment_attempts
         WHERE assessment_id = a.id AND user_id = ${userId}) AS attempt_count,
        (SELECT MAX(percentage) FROM user_assessment_attempts
         WHERE assessment_id = a.id AND user_id = ${userId}) AS best_score
      FROM assessments a
      WHERE a.course_id = ${courseId} AND a.is_active = 1
      ORDER BY a.created_at
    `);
  }

  /** Latest attempt per assessment for this course — one query, not one per row. */
  async latestAttemptsForCourse(courseId: number, userId: number) {
    return this.db.all<{
      assessment_id: number;
      percentage: number;
      is_passed: number;
      submitted_at: string;
    }>(sql`
      SELECT t.assessment_id, t.percentage, t.is_passed, t.submitted_at
      FROM user_assessment_attempts t
      JOIN assessments a ON a.id = t.assessment_id
      WHERE a.course_id = ${courseId} AND t.user_id = ${userId}
        AND t.submitted_at = (
          SELECT MAX(t2.submitted_at) FROM user_assessment_attempts t2
          WHERE t2.assessment_id = t.assessment_id AND t2.user_id = ${userId}
        )
    `);
  }

  /* ─────────────────────────────────────────────
     Lesson detail
  ───────────────────────────────────────────── */

  async findLessonWithModule(lessonId: number) {
    const rows = await this.db.all<{
      id: number;
      module_id: number;
      title: string;
      description: string | null;
      content_type: string;
      content_url: string | null;
      video_key: string | null;
      caption_key: string | null;
      document_key: string | null;
      document_name: string | null;
      document_mime: string | null;
      document_size_bytes: number | null;
      scorm_package_id: number | null;
      duration_minutes: number | null;
      sort_order: number;
      module_title: string;
      course_id: number;
      module_sort_order: number;
      session_id: number | null;
      session_type: string | null;
      trainer: string | null;
      venue_url: string | null;
      session_date: string | null;
      start_time: string | null;
      end_time: string | null;
      session_status: string | null;
    }>(sql`
      SELECT l.*, cm.title AS module_title, cm.course_id,
             cm.sort_order AS module_sort_order,
             s.id AS session_id, s.session_type, s.trainer, s.venue_url,
             s.date AS session_date, s.start_time, s.end_time,
             s.status AS session_status
      FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      LEFT JOIN courses c ON c.id = cm.course_id
      LEFT JOIN sessions s ON s.id = c.session_id
      WHERE l.id = ${lessonId} AND l.is_active = 1
    `);
    return rows[0] ?? null;
  }

  /**
   * A lesson's supporting resources.
   *
   * `file_key` is deliberately NOT selected: the learner never sees a storage
   * key. Opening an uploaded resource goes through
   * `GET /learner/resources/:id/url`, which signs it per click.
   */
  async lessonResources(lessonId: number) {
    return this.db.all<{
      id: number;
      title: string;
      resource_type: string;
      source: string;
      file_name: string | null;
      file_size_bytes: number | null;
      mime_type: string | null;
      url: string | null;
    }>(sql`
      SELECT id, title, resource_type, source, file_name, file_size_bytes,
             mime_type, url
      FROM lesson_resources
      WHERE lesson_id = ${lessonId}
      ORDER BY sort_order, id
    `);
  }

  async findLessonCourse(lessonId: number) {
    const rows = await this.db.all<{
      id: number;
      course_id: number;
      content_type: string;
    }>(sql`
      SELECT l.id, l.content_type, cm.course_id FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.id = ${lessonId}
    `);
    return rows[0] ?? null;
  }

  async markLessonComplete(userId: number, lessonId: number): Promise<void> {
    await this.db
      .insert(userLessonCompletions)
      .values({ userId, lessonId })
      .onConflictDoNothing();
  }

  /* ─────────────────────────────────────────────
     Activity feeds
  ───────────────────────────────────────────── */

  async lessonEvents(userId: number, limit: number) {
    return this.db.all<{
      event_time: string;
      title: string;
      course_name: string;
    }>(sql`
      SELECT ulc.completed_at AS event_time, l.title, c.name AS course_name
      FROM user_lesson_completions ulc
      JOIN lessons l ON l.id = ulc.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      JOIN courses c ON c.id = cm.course_id
      WHERE ulc.user_id = ${userId}
      ORDER BY ulc.completed_at DESC LIMIT ${limit}
    `);
  }

  async assessmentEvents(userId: number, limit: number, passedOnly = false) {
    const passedFilter = passedOnly ? sql`AND t.is_passed = 1` : sql``;
    return this.db.all<{
      event_time: string;
      title: string;
      course_name: string;
      is_passed: number;
    }>(sql`
      SELECT t.submitted_at AS event_time, a.title, c.name AS course_name, t.is_passed
      FROM user_assessment_attempts t
      JOIN assessments a ON a.id = t.assessment_id
      JOIN courses c ON c.id = a.course_id
      WHERE t.user_id = ${userId} ${passedFilter}
      ORDER BY t.submitted_at DESC LIMIT ${limit}
    `);
  }

  async assignmentEvents(userId: number, limit: number) {
    return this.db.all<{ event_time: string; title: string }>(sql`
      SELECT uca.assigned_at AS event_time, c.name AS title
      FROM user_course_assignments uca
      JOIN courses c ON c.id = uca.course_id
      WHERE uca.user_id = ${userId}
      ORDER BY uca.assigned_at DESC LIMIT ${limit}
    `);
  }

  async scormEvents(userId: number, limit: number) {
    return this.db.all<{
      event_time: string;
      title: string;
      course_name: string;
      lesson_status: string | null;
      completion_status: string | null;
    }>(sql`
      SELECT st.updated_at AS event_time, sp.title,
             COALESCE(c.name, sp.title) AS course_name,
             st.lesson_status, st.completion_status
      FROM scorm_tracking st
      JOIN scorm_packages sp ON sp.id = st.package_id
      LEFT JOIN courses c ON c.id = sp.course_id
      WHERE st.user_id = ${userId}
      ORDER BY st.updated_at DESC LIMIT ${limit}
    `);
  }

  async recentAttempts(userId: number, limit: number) {
    return this.db.all(sql`
      SELECT t.*, a.title AS assessment_title, c.name AS course_name
      FROM user_assessment_attempts t
      JOIN assessments a ON a.id = t.assessment_id
      JOIN courses c ON c.id = a.course_id
      WHERE t.user_id = ${userId}
      ORDER BY t.submitted_at DESC LIMIT ${limit}
    `);
  }

  async allAttempts(userId: number) {
    return this.db.all<{
      assessment_title: string;
      course_name: string;
      score: number;
      is_passed: number;
      submitted_at: string;
    }>(sql`
      SELECT a.title AS assessment_title, c.name AS course_name,
             t.percentage AS score, t.is_passed, t.submitted_at
      FROM user_assessment_attempts t
      JOIN assessments a ON a.id = t.assessment_id
      JOIN courses c ON c.id = a.course_id
      WHERE t.user_id = ${userId}
      ORDER BY t.submitted_at DESC
    `);
  }

  /* ─────────────────────────────────────────────
     Progress page extras
  ───────────────────────────────────────────── */

  /** SCORM tracking rows for the learner's assigned courses, with course id. */
  async scormForAssignedCourses(userId: number) {
    return this.db.all<{
      course_id: number;
      lesson_status: string | null;
      completion_status: string | null;
      success_status: string | null;
      score_raw: number | null;
      score_max: number | null;
      total_time: string | null;
      cmi_data: string | null;
    }>(sql`
      SELECT cm.course_id, st.lesson_status, st.completion_status,
             st.success_status, st.score_raw, st.score_max,
             st.total_time, st.cmi_data
      FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      LEFT JOIN scorm_tracking st
        ON st.package_id = l.scorm_package_id AND st.user_id = ${userId}
      WHERE l.content_type = 'scorm' AND l.scorm_package_id IS NOT NULL
        AND l.is_active = 1 AND cm.is_active = 1
        AND cm.course_id IN (
          SELECT course_id FROM user_course_assignments WHERE user_id = ${userId}
        )
    `);
  }

  /**
   * Per-course lesson totals counting SCORM completion as done — mirrors the
   * legacy progress query, for every assigned course at once.
   */
  async courseLessonProgress(userId: number) {
    return this.db.all<{
      course_id: number;
      total: number;
      done: number;
    }>(sql`
      SELECT cm.course_id,
        COUNT(l.id) AS total,
        SUM(CASE WHEN
          l.id IN (SELECT lesson_id FROM user_lesson_completions WHERE user_id = ${userId})
          OR (l.content_type = 'scorm' AND l.scorm_package_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM scorm_tracking st
                WHERE st.package_id = l.scorm_package_id AND st.user_id = ${userId}
                  AND (st.completion_status = 'completed'
                       OR st.lesson_status IN ('passed', 'completed'))
              ))
          THEN 1 ELSE 0 END) AS done
      FROM course_modules cm
      JOIN lessons l ON l.module_id = cm.id AND l.is_active = 1
      WHERE cm.is_active = 1
        AND cm.course_id IN (
          SELECT course_id FROM user_course_assignments WHERE user_id = ${userId}
        )
      GROUP BY cm.course_id
    `);
  }

  /** Hours per course for this month — powers the training-mode breakdown. */
  async monthlyHoursByCourse(userId: number, month: string) {
    return this.db.all<{ course_id: number; hrs: number }>(sql`
      SELECT cm.course_id,
             COALESCE(ROUND(SUM(l.duration_minutes) / 60.0, 1), 0) AS hrs
      FROM user_lesson_completions ulc
      JOIN lessons l ON l.id = ulc.lesson_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE ulc.user_id = ${userId}
        AND to_char(ulc.completed_at, 'YYYY-MM') = ${month}
      GROUP BY cm.course_id
    `);
  }

  /* ─────────────────────────────────────────────
     Password
  ───────────────────────────────────────────── */

  async findActiveWithPassword(userId: number) {
    const rows = await this.db.all<{ id: number; password: string }>(sql`
      SELECT id, password FROM users WHERE id = ${userId} AND is_active = 1
    `);
    return rows[0] ?? null;
  }

  async updatePassword(userId: number, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({ password: passwordHash })
      .where(eq(users.id, userId));
  }
}
