import { Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import {
  courseModules,
  courses,
  lessons,
  userCourseAssignments,
} from '@/database/schema';

@Injectable()
export class CoursesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /* ── Courses ── */

  /**
   * Content library listing.
   *
   * `completion_pct` used to be a follow-up query per course inside a loop.
   * It is now a correlated subquery: for each course, count the assignments
   * whose completed-lesson count reaches the course's active lesson count.
   */
  async listWithStats() {
    return this.db.all(sql`
      SELECT c.*,
        (SELECT COUNT(*) FROM course_modules
         WHERE course_id = c.id AND is_active = 1) AS modules_count,
        (SELECT COUNT(*) FROM lessons l
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND l.is_active = 1) AS lessons_count,
        (SELECT COUNT(*) FROM assessments
         WHERE course_id = c.id AND is_active = 1) AS assessments_count,
        (SELECT COUNT(*) FROM user_course_assignments
         WHERE course_id = c.id) AS enrollments_count,
        (SELECT COALESCE(SUM(l.duration_minutes), 0) FROM lessons l
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND l.is_active = 1
           AND cm.is_active = 1) AS total_duration_minutes,
        (SELECT MIN(a.passing_score) FROM assessments a
         WHERE a.course_id = c.id AND a.is_active = 1) AS passing_score,
        (SELECT a.title FROM assessments a
         WHERE a.course_id = c.id AND a.is_active = 1
         ORDER BY a.created_at LIMIT 1) AS first_assessment_title,
        (SELECT COALESCE(ROUND(AVG(uaa.percentage)), 0)
         FROM user_assessment_attempts uaa
         JOIN assessments a ON a.id = uaa.assessment_id
         WHERE a.course_id = c.id) AS avg_score,
        (SELECT COUNT(*) FROM user_course_assignments uca
         WHERE uca.course_id = c.id
           AND (SELECT COUNT(*) FROM lessons l2
                JOIN course_modules cm2 ON cm2.id = l2.module_id
                WHERE cm2.course_id = c.id AND l2.is_active = 1) > 0
           AND (SELECT COUNT(*) FROM user_lesson_completions ulc
                JOIN lessons l3 ON l3.id = ulc.lesson_id
                JOIN course_modules cm3 ON cm3.id = l3.module_id
                WHERE cm3.course_id = c.id AND ulc.user_id = uca.user_id
                  AND l3.is_active = 1 AND cm3.is_active = 1)
             >= (SELECT COUNT(*) FROM lessons l4
                 JOIN course_modules cm4 ON cm4.id = l4.module_id
                 WHERE cm4.course_id = c.id AND l4.is_active = 1)
        ) AS completed_enrollments
      FROM courses c
      ORDER BY c.created_at DESC
    `);
  }

  async findById(id: number) {
    const rows = await this.db
      .select()
      .from(courses)
      .where(eq(courses.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async createCourse(input: {
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    isActive: boolean;
  }) {
    const [created] = await this.db
      .insert(courses)
      .values({
        name: input.name,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        isActive: input.isActive ? 1 : 0,
      })
      .returning();
    return created;
  }

  async updateCourse(
    id: number,
    input: {
      name: string;
      description: string | null;
      thumbnailUrl: string | null;
      isActive: boolean;
    },
  ) {
    const [updated] = await this.db
      .update(courses)
      .set({
        name: input.name,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        isActive: input.isActive ? 1 : 0,
        updatedAt: sql`now()`,
      })
      .where(eq(courses.id, id))
      .returning();
    return updated;
  }

  async deleteCourse(id: number): Promise<void> {
    await this.db.delete(courses).where(eq(courses.id, id));
  }

  /* ── Modules ── */

  /** Modules for a course. Lessons are fetched in one companion query. */
  async listModules(courseId: number) {
    return this.db.all<{
      id: number;
      course_id: number;
      title: string;
      description: string | null;
      sort_order: number;
      is_active: number;
      created_at: string;
      lessons_count: number;
    }>(sql`
      SELECT cm.*,
        (SELECT COUNT(*) FROM lessons
         WHERE module_id = cm.id AND is_active = 1) AS lessons_count
      FROM course_modules cm
      WHERE cm.course_id = ${courseId}
      ORDER BY cm.sort_order, cm.created_at
    `);
  }

  /**
   * Every active lesson across a course's modules, in one query. The legacy
   * handler ran one query per module inside a loop.
   */
  async listLessonsForCourse(courseId: number) {
    return this.db.all<Record<string, unknown> & { module_id: number }>(sql`
      SELECT l.* FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE cm.course_id = ${courseId} AND l.is_active = 1
      ORDER BY l.sort_order, l.created_at
    `);
  }

  async nextModuleSortOrder(courseId: number): Promise<number> {
    const rows = await this.db.all<{ m: number | null }>(sql`
      SELECT MAX(sort_order) AS m FROM course_modules WHERE course_id = ${courseId}
    `);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  async createModule(input: {
    courseId: number;
    title: string;
    description: string | null;
    sortOrder: number;
  }) {
    const [created] = await this.db
      .insert(courseModules)
      .values({
        courseId: input.courseId,
        title: input.title,
        description: input.description,
        sortOrder: input.sortOrder,
      })
      .returning();
    return created;
  }

  async updateModule(
    id: number,
    input: { title: string; description: string | null; isActive: boolean },
  ) {
    const [updated] = await this.db
      .update(courseModules)
      .set({
        title: input.title,
        description: input.description,
        isActive: input.isActive ? 1 : 0,
      })
      .where(eq(courseModules.id, id))
      .returning();
    return updated;
  }

  async deleteModule(id: number): Promise<void> {
    await this.db.delete(courseModules).where(eq(courseModules.id, id));
  }

  /* ── Lessons ── */

  async listLessonsByModule(moduleId: number) {
    return this.db
      .select()
      .from(lessons)
      .where(eq(lessons.moduleId, moduleId))
      .orderBy(asc(lessons.sortOrder), asc(lessons.createdAt));
  }

  async findLessonById(id: number) {
    const rows = await this.db
      .select()
      .from(lessons)
      .where(eq(lessons.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async nextLessonSortOrder(moduleId: number): Promise<number> {
    const rows = await this.db.all<{ m: number | null }>(sql`
      SELECT MAX(sort_order) AS m FROM lessons WHERE module_id = ${moduleId}
    `);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  async createLesson(values: typeof lessons.$inferInsert) {
    const [created] = await this.db.insert(lessons).values(values).returning();
    return created;
  }

  async updateLesson(
    id: number,
    values: Partial<typeof lessons.$inferInsert>,
  ) {
    const [updated] = await this.db
      .update(lessons)
      .set(values)
      .where(eq(lessons.id, id))
      .returning();
    return updated;
  }

  async deleteLesson(id: number): Promise<void> {
    await this.db.delete(lessons).where(eq(lessons.id, id));
  }

  /* ── Assignments ── */

  async listAssignments(courseId: number) {
    return this.db.all<Record<string, unknown> & { user_id: number }>(sql`
      SELECT uca.*, u.first_name, u.last_name, u.email,
        (SELECT COUNT(*) FROM user_lesson_completions ulc
         JOIN lessons l ON l.id = ulc.lesson_id
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = ${courseId}
           AND ulc.user_id = uca.user_id) AS completed_lessons,
        (SELECT COUNT(*) FROM lessons l
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = ${courseId}
           AND l.is_active = 1 AND cm.is_active = 1) AS total_lessons
      FROM user_course_assignments uca
      JOIN users u ON u.id = uca.user_id
      WHERE uca.course_id = ${courseId}
      ORDER BY uca.assigned_at DESC
    `);
  }

  /** SCORM tracking for every learner on this course, grouped in the service. */
  async listScormResultsForCourse(courseId: number) {
    return this.db.all<Record<string, unknown> & { user_id: number }>(sql`
      SELECT st.user_id, st.package_id, sp.title AS package_title,
             st.lesson_status, st.completion_status, st.success_status,
             st.score_raw, st.score_max, st.total_time
      FROM scorm_tracking st
      JOIN scorm_packages sp ON sp.id = st.package_id
      JOIN lessons l ON l.scorm_package_id = st.package_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE cm.course_id = ${courseId}
    `);
  }

  async findLearner(userId: number) {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM users WHERE id = ${userId} AND role = 'learner'
    `);
    return rows[0] ?? null;
  }

  async findAssignment(userId: number, courseId: number) {
    const rows = await this.db
      .select({ id: userCourseAssignments.id })
      .from(userCourseAssignments)
      .where(
        sql`${userCourseAssignments.userId} = ${userId} AND ${userCourseAssignments.courseId} = ${courseId}`,
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async createAssignment(input: {
    userId: number;
    courseId: number;
    assignedBy: number;
    dueDate: string | null;
  }): Promise<void> {
    await this.db.insert(userCourseAssignments).values({
      userId: input.userId,
      courseId: input.courseId,
      assignedBy: input.assignedBy,
      dueDate: input.dueDate,
    });
  }

  async updateAssignmentDueDate(
    userId: number,
    courseId: number,
    dueDate: string,
  ): Promise<void> {
    await this.db
      .update(userCourseAssignments)
      .set({ dueDate })
      .where(
        sql`${userCourseAssignments.userId} = ${userId} AND ${userCourseAssignments.courseId} = ${courseId}`,
      );
  }

  async deleteAssignment(assignmentId: number): Promise<void> {
    await this.db
      .delete(userCourseAssignments)
      .where(eq(userCourseAssignments.id, assignmentId));
  }
}
