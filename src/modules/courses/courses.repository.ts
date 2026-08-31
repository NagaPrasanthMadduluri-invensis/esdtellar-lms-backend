import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import {
  courseModules,
  courses,
  lessons,
  userCourseAssignments,
  lessonResources,
} from '@/database/schema';

@Injectable()
export class CoursesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * `scope` is first on every method here (and across the sibling modules): it
   * is required, security-relevant, reads like a context argument, and can
   * never collide with an optional or defaulted parameter that follows it.
   */

  /* ── Courses ── */

  /**
   * Content library listing.
   *
   * `completion_pct` used to be a follow-up query per course inside a loop.
   * It is now a correlated subquery: for each course, count the assignments
   * whose completed-lesson count reaches the course's active lesson count.
   *
   * `c` is the query root — every subquery below is anchored on `c.id`, so it
   * inherits tenancy from the outer WHERE and needs no predicate of its own.
   */
  async listWithStats(scope: OrgScope) {
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
      WHERE ${orgScope('c', scope)}
      ORDER BY c.created_at DESC
    `);
  }

  /* ── Lesson resources ───────────────────────────────────────────────────
     Supporting material on a lesson. Reference only — no duration, no bearing
     on completion or learning hours (§10.4).
  ────────────────────────────────────────────────────────────────────────── */

  async listResources(scope: OrgScope, lessonId: number) {
    return this.db
      .select({
        id: lessonResources.id,
        lesson_id: lessonResources.lessonId,
        title: lessonResources.title,
        resource_type: lessonResources.resourceType,
        source: lessonResources.source,
        file_name: lessonResources.fileName,
        file_size_bytes: lessonResources.fileSizeBytes,
        mime_type: lessonResources.mimeType,
        url: lessonResources.url,
        sort_order: lessonResources.sortOrder,
        created_at: lessonResources.createdAt,
      })
      .from(lessonResources)
      .where(
        and(
          eq(lessonResources.lessonId, lessonId),
          eq(lessonResources.organizationId, scope.organizationId),
        ),
      )
      .orderBy(asc(lessonResources.sortOrder), asc(lessonResources.id));
  }

  /**
   * Resources for MANY lessons in one query, so the admin lesson list does not
   * fan out into a query per row (§7.1).
   */
  async listResourcesForLessons(scope: OrgScope, lessonIds: number[]) {
    if (lessonIds.length === 0) return [];
    return this.db.all<{
      id: number;
      lesson_id: number;
      title: string;
      resource_type: string;
      source: string;
      file_name: string | null;
      file_size_bytes: number | null;
      mime_type: string | null;
      url: string | null;
      sort_order: number;
    }>(sql`
      SELECT id, lesson_id, title, resource_type, source,
             file_name, file_size_bytes, mime_type, url, sort_order
      FROM lesson_resources
      WHERE lesson_id IN (${sql.join(lessonIds.map((id) => sql`${id}`), sql`, `)})
        AND ${orgScope('lesson_resources', scope)}
      ORDER BY lesson_id, sort_order, id
    `);
  }

  /** The stored key too — the caller needs it to drop the object on delete. */
  async findResourceById(scope: OrgScope, resourceId: number) {
    const rows = await this.db
      .select({
        id: lessonResources.id,
        lessonId: lessonResources.lessonId,
        fileKey: lessonResources.fileKey,
      })
      .from(lessonResources)
      .where(
        and(
          eq(lessonResources.id, resourceId),
          eq(lessonResources.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async nextResourceSortOrder(scope: OrgScope, lessonId: number): Promise<number> {
    const rows = await this.db.all<{ next: number }>(sql`
      SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
      FROM lesson_resources
      WHERE lesson_id = ${lessonId} AND ${orgScope('lesson_resources', scope)}
    `);
    return Number(rows[0]?.next ?? 0);
  }

  /** Content: the owning course's org — the caller supplies `organizationId`. */
  async createResource(values: typeof lessonResources.$inferInsert) {
    const [created] = await this.db
      .insert(lessonResources)
      .values(values)
      .returning();
    return created;
  }

  /** Just the stored keys, for cleaning up when a lesson is deleted. */
  async listResourcesForKeys(scope: OrgScope, lessonId: number) {
    return this.db.all<{ file_key: string | null }>(sql`
      SELECT file_key FROM lesson_resources
      WHERE lesson_id = ${lessonId} AND file_key IS NOT NULL
        AND ${orgScope('lesson_resources', scope)}
    `);
  }

  async deleteResource(scope: OrgScope, resourceId: number): Promise<void> {
    await this.db
      .delete(lessonResources)
      .where(
        and(
          eq(lessonResources.id, resourceId),
          eq(lessonResources.organizationId, scope.organizationId),
        ),
      );
  }

  /* ── Session trainings ─────────────────────────────────────────────────
     A session's companion course is generated and kept in step by the
     sessions module (migration 0005). These three lookups are what lets the
     course editor refuse to edit one out from under its session.
  ────────────────────────────────────────────────────────────────────────── */

  async findSessionIdForCourse(
    scope: OrgScope,
    courseId: number,
  ): Promise<number | null> {
    const rows = await this.db.all<{ session_id: number | null }>(sql`
      SELECT session_id FROM courses
      WHERE id = ${courseId} AND ${orgScope('courses', scope)}
    `);
    return rows[0]?.session_id ?? null;
  }

  async findSessionIdForModule(
    scope: OrgScope,
    moduleId: number,
  ): Promise<number | null> {
    const rows = await this.db.all<{ session_id: number | null }>(sql`
      SELECT c.session_id FROM course_modules cm
      JOIN courses c ON c.id = cm.course_id
      WHERE cm.id = ${moduleId} AND ${orgScope('cm', scope)}
    `);
    return rows[0]?.session_id ?? null;
  }

  async findSessionIdForLesson(
    scope: OrgScope,
    lessonId: number,
  ): Promise<number | null> {
    const rows = await this.db.all<{ session_id: number | null }>(sql`
      SELECT c.session_id FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      JOIN courses c ON c.id = cm.course_id
      WHERE l.id = ${lessonId} AND ${orgScope('l', scope)}
    `);
    return rows[0]?.session_id ?? null;
  }

  async findById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select()
      .from(courses)
      .where(and(eq(courses.id, id), eq(courses.organizationId, scope.organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Content: takes the OWNER's org — `scope.organizationId` for the admin creating it. */
  async createCourse(input: {
    organizationId: number;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    isActive: boolean;
  }) {
    const [created] = await this.db
      .insert(courses)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        isActive: input.isActive ? 1 : 0,
      })
      .returning();
    return created;
  }

  async updateCourse(
    scope: OrgScope,
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
      .where(and(eq(courses.id, id), eq(courses.organizationId, scope.organizationId)))
      .returning();
    return updated;
  }

  async deleteCourse(scope: OrgScope, id: number): Promise<void> {
    await this.db
      .delete(courses)
      .where(and(eq(courses.id, id), eq(courses.organizationId, scope.organizationId)));
  }

  /* ── Modules ── */

  /** Modules for a course. Lessons are fetched in one companion query. */
  async listModules(scope: OrgScope, courseId: number) {
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
      WHERE cm.course_id = ${courseId} AND ${orgScope('cm', scope)}
      ORDER BY cm.sort_order, cm.created_at
    `);
  }

  /**
   * Every active lesson across a course's modules, in one query. The legacy
   * handler ran one query per module inside a loop.
   */
  async listLessonsForCourse(scope: OrgScope, courseId: number) {
    return this.db.all<Record<string, unknown> & { module_id: number }>(sql`
      SELECT l.* FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE cm.course_id = ${courseId} AND l.is_active = 1
        AND ${orgScope('l', scope)}
      ORDER BY l.sort_order, l.created_at
    `);
  }

  async nextModuleSortOrder(scope: OrgScope, courseId: number): Promise<number> {
    const rows = await this.db.all<{ m: number | null }>(sql`
      SELECT MAX(sort_order) AS m FROM course_modules
      WHERE course_id = ${courseId} AND ${orgScope('course_modules', scope)}
    `);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  /** Current state of a module — used to preserve flags the caller omitted. */
  async findModuleById(scope: OrgScope, moduleId: number) {
    const rows = await this.db
      .select()
      .from(courseModules)
      .where(
        and(
          eq(courseModules.id, moduleId),
          eq(courseModules.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Content: takes the OWNER's org — the owning course's org. */
  async createModule(input: {
    organizationId: number;
    courseId: number;
    title: string;
    description: string | null;
    sortOrder: number;
  }) {
    const [created] = await this.db
      .insert(courseModules)
      .values({
        organizationId: input.organizationId,
        courseId: input.courseId,
        title: input.title,
        description: input.description,
        sortOrder: input.sortOrder,
      })
      .returning();
    return created;
  }

  async updateModule(
    scope: OrgScope,
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
      .where(
        and(
          eq(courseModules.id, id),
          eq(courseModules.organizationId, scope.organizationId),
        ),
      )
      .returning();
    return updated;
  }

  async deleteModule(scope: OrgScope, id: number): Promise<void> {
    await this.db
      .delete(courseModules)
      .where(
        and(
          eq(courseModules.id, id),
          eq(courseModules.organizationId, scope.organizationId),
        ),
      );
  }

  /* ── Lessons ── */

  async listLessonsByModule(scope: OrgScope, moduleId: number) {
    return this.db
      .select()
      .from(lessons)
      .where(
        and(
          eq(lessons.moduleId, moduleId),
          eq(lessons.organizationId, scope.organizationId),
        ),
      )
      .orderBy(asc(lessons.sortOrder), asc(lessons.createdAt));
  }

  async findLessonById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select()
      .from(lessons)
      .where(and(eq(lessons.id, id), eq(lessons.organizationId, scope.organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async nextLessonSortOrder(scope: OrgScope, moduleId: number): Promise<number> {
    const rows = await this.db.all<{ m: number | null }>(sql`
      SELECT MAX(sort_order) AS m FROM lessons
      WHERE module_id = ${moduleId} AND ${orgScope('lessons', scope)}
    `);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  /** Content: takes the OWNER's org — the caller supplies `organizationId`. */
  async createLesson(values: typeof lessons.$inferInsert) {
    const [created] = await this.db.insert(lessons).values(values).returning();
    return created;
  }

  async updateLesson(
    scope: OrgScope,
    id: number,
    values: Partial<typeof lessons.$inferInsert>,
  ) {
    const [updated] = await this.db
      .update(lessons)
      .set(values)
      .where(and(eq(lessons.id, id), eq(lessons.organizationId, scope.organizationId)))
      .returning();
    return updated;
  }

  async deleteLesson(scope: OrgScope, id: number): Promise<void> {
    await this.db
      .delete(lessons)
      .where(and(eq(lessons.id, id), eq(lessons.organizationId, scope.organizationId)));
  }

  /* ── Assignments ── */

  async listAssignments(scope: OrgScope, courseId: number) {
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
      WHERE uca.course_id = ${courseId} AND ${orgScope('uca', scope)}
      ORDER BY uca.assigned_at DESC
    `);
  }

  /**
   * SCORM tracking for every learner on this course, grouped in the service.
   * Scoped through `course_modules`, the tenant-owned table this module owns —
   * that alone keeps a foreign course's tracking rows out of the join.
   */
  async listScormResultsForCourse(scope: OrgScope, courseId: number) {
    return this.db.all<Record<string, unknown> & { user_id: number }>(sql`
      SELECT st.user_id, st.package_id, sp.title AS package_title,
             st.lesson_status, st.completion_status, st.success_status,
             st.score_raw, st.score_max, st.total_time
      FROM scorm_tracking st
      JOIN scorm_packages sp ON sp.id = st.package_id
      JOIN lessons l ON l.scorm_package_id = st.package_id
      JOIN course_modules cm ON cm.id = l.module_id
      WHERE cm.course_id = ${courseId} AND ${orgScope('cm', scope)}
    `);
  }

  async findLearner(scope: OrgScope, userId: number) {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM users
      WHERE id = ${userId} AND role = 'learner' AND ${orgScope('users', scope)}
    `);
    return rows[0] ?? null;
  }

  async findAssignment(scope: OrgScope, userId: number, courseId: number) {
    const rows = await this.db
      .select({ id: userCourseAssignments.id })
      .from(userCourseAssignments)
      .where(
        and(
          eq(userCourseAssignments.userId, userId),
          eq(userCourseAssignments.courseId, courseId),
          eq(userCourseAssignments.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Assigns many learners in ONE statement.
   *
   * "Assign all" for a department used to be a client-side loop issuing a
   * request per learner — 20 round trips for 20 people, each able to fail
   * independently and leave the department half-assigned. Already-assigned
   * learners are skipped by the UNIQUE(user_id, course_id) conflict rather
   * than by filtering them first, so the caller does not need to know who is
   * already enrolled.
   *
   * Activity: takes the ASSIGNED learners' org, which is `scope` here — the
   * admin's own org, already the one every candidate learner was verified
   * against.
   */
  async createAssignments(input: {
    organizationId: number;
    userIds: number[];
    courseId: number;
    assignedBy: number;
    dueDate: string | null;
  }): Promise<number> {
    if (input.userIds.length === 0) return 0;

    const rows = await this.db
      .insert(userCourseAssignments)
      .values(
        input.userIds.map((userId) => ({
          organizationId: input.organizationId,
          userId,
          courseId: input.courseId,
          assignedBy: input.assignedBy,
          dueDate: input.dueDate,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: userCourseAssignments.id });

    return rows.length;
  }

  async createAssignment(input: {
    organizationId: number;
    userId: number;
    courseId: number;
    assignedBy: number;
    dueDate: string | null;
  }): Promise<void> {
    await this.db.insert(userCourseAssignments).values({
      organizationId: input.organizationId,
      userId: input.userId,
      courseId: input.courseId,
      assignedBy: input.assignedBy,
      dueDate: input.dueDate,
    });
  }

  async updateAssignmentDueDate(
    scope: OrgScope,
    userId: number,
    courseId: number,
    dueDate: string,
  ): Promise<void> {
    await this.db
      .update(userCourseAssignments)
      .set({ dueDate })
      .where(
        and(
          eq(userCourseAssignments.userId, userId),
          eq(userCourseAssignments.courseId, courseId),
          eq(userCourseAssignments.organizationId, scope.organizationId),
        ),
      );
  }

  async deleteAssignment(scope: OrgScope, assignmentId: number): Promise<void> {
    await this.db
      .delete(userCourseAssignments)
      .where(
        and(
          eq(userCourseAssignments.id, assignmentId),
          eq(userCourseAssignments.organizationId, scope.organizationId),
        ),
      );
  }
}
