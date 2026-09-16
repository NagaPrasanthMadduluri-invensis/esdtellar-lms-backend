import { Injectable } from '@nestjs/common';
import { type SQL, and, asc, eq, inArray, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import {
  courseModules,
  courses,
  lessons,
  userCourseAssignments,
  lessonResources,
} from '@/database/schema';

/**
 * An `IN (...)` list of integer ids.
 *
 * NOT `= ANY(${ids})`: Drizzle's `sql` template does not bind a JS array as a
 * single Postgres array parameter — it expands it into comma-separated bound
 * params, which is `IN`'s shape and not `ANY`'s. The result parsed as a record
 * and the query failed at runtime with `operator does not exist: integer =
 * record`, so every caller 500'd. Same idiom as `JourneysRepository.idList`.
 */
function idList(ids: number[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}::int`), sql`, `)})`;
}

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
  /**
   * The Course Library list.
   *
   * `archived` swaps between the active library and the archive — they are
   * never mixed. An archived course showing up in the assign-learning picker
   * is precisely what archiving exists to prevent, so the predicate is in the
   * query rather than left to the caller to remember.
   */
  async listWithStats(scope: OrgScope, archived = false) {
    return this.db.all(sql`
      SELECT c.*,
        (SELECT COUNT(*) FROM course_modules
         WHERE course_id = c.id AND is_active = 1) AS modules_count,
        (SELECT COUNT(*) FROM lessons l
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND l.is_active = 1) AS lessons_count,
        (SELECT COUNT(*) FROM assessments
         WHERE course_id = c.id AND is_active = 1) AS assessments_count,
        -- ORG-SCOPED, unlike the content counts above it. A platform-owned
        -- course is readable by every tenant (contentScope) but its
        -- assignments are ACTIVITY and belong to one org each. Unscoped, this
        -- org's admin saw 13 enrolments on a global course of which 2 were
        -- another tenant's — a cross-tenant count, and a number that
        -- disagreed with the roster popup, which was scoped correctly.
        (SELECT COUNT(*) FROM user_course_assignments uca0
         WHERE uca0.course_id = c.id AND ${orgScope('uca0', scope)}) AS enrollments_count,
        (SELECT COALESCE(SUM(l.duration_minutes), 0) FROM lessons l
         JOIN course_modules cm ON cm.id = l.module_id
         WHERE cm.course_id = c.id AND l.is_active = 1
           AND cm.is_active = 1) AS total_duration_minutes,
        (SELECT MIN(a.passing_score) FROM assessments a
         WHERE a.course_id = c.id AND a.is_active = 1) AS passing_score,
        (SELECT a.title FROM assessments a
         WHERE a.course_id = c.id AND a.is_active = 1
         ORDER BY a.created_at LIMIT 1) AS first_assessment_title,
        -- Same rule: an attempt is activity, so another tenant's scores must
        -- not move this org's average on a shared course.
        (SELECT COALESCE(ROUND(AVG(uaa.percentage)), 0)
         FROM user_assessment_attempts uaa
         JOIN assessments a ON a.id = uaa.assessment_id
         WHERE a.course_id = c.id AND ${orgScope('uaa', scope)}) AS avg_score,
        (SELECT COUNT(*) FROM user_course_assignments uca
         WHERE uca.course_id = c.id
           AND ${orgScope('uca', scope)}
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
        ) AS completed_enrollments,
        -- Started but not finished. Counted rather than estimated: the
        -- reference mock derives "in progress" as 65% of the remainder, which
        -- is a made-up number sitting next to two real ones on the same bar.
        (SELECT COUNT(*) FROM user_course_assignments uca
          WHERE uca.course_id = c.id
            AND ${orgScope('uca', scope)}
            AND (SELECT COUNT(*) FROM user_lesson_completions ulc
                  JOIN lessons l5 ON l5.id = ulc.lesson_id
                  JOIN course_modules cm5 ON cm5.id = l5.module_id
                 WHERE cm5.course_id = c.id AND ulc.user_id = uca.user_id
                   AND l5.is_active = 1 AND cm5.is_active = 1) > 0
            AND (SELECT COUNT(*) FROM user_lesson_completions ulc
                  JOIN lessons l6 ON l6.id = ulc.lesson_id
                  JOIN course_modules cm6 ON cm6.id = l6.module_id
                 WHERE cm6.course_id = c.id AND ulc.user_id = uca.user_id
                   AND l6.is_active = 1 AND cm6.is_active = 1)
              < (SELECT COUNT(*) FROM lessons l7
                  JOIN course_modules cm7 ON cm7.id = l7.module_id
                 WHERE cm7.course_id = c.id AND l7.is_active = 1 AND cm7.is_active = 1)
        ) AS in_progress_enrollments
      FROM courses c
      WHERE ${contentScope('c', scope)}
        AND c.archived_at IS ${archived ? sql`NOT NULL` : sql`NULL`}
      ORDER BY c.created_at DESC
    `);
  }

  /** How many of this org's courses are archived — for the toggle's badge. */
  async archivedCount(scope: OrgScope): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM courses c
      WHERE ${contentScope('c', scope)} AND c.archived_at IS NOT NULL
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Archive or restore, in one statement for any number of ids.
   *
   * `is_active` is untouched on purpose: archive is orthogonal to
   * published/draft, so a course restored from the archive comes back exactly
   * as published or draft as it went in, rather than to a default somebody
   * chose for it.
   */
  async setArchived(
    scope: OrgScope,
    ids: number[],
    archived: boolean,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE courses c
         SET archived_at = ${archived ? sql`now()` : sql`NULL`},
             updated_at = now()
       WHERE c.id IN ${idList(ids)}
         AND c.organization_id = ${scope.organizationId}
         AND c.session_id IS NULL
      RETURNING c.id
    `);
    return rows.length;
  }

  /**
   * Bulk publish / unpublish.
   *
   * Scoped to `organization_id`, NOT `contentScope`: a platform-owned course
   * is readable by every tenant and must not be publishable by any of them.
   * `session_id IS NULL` keeps session trainings out, the same refusal
   * `CoursesService.assertNotSessionTraining` makes one at a time (§10.7).
   */
  async setPublished(
    scope: OrgScope,
    ids: number[],
    published: boolean,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE courses c
         SET is_active = ${published ? 1 : 0}, updated_at = now()
       WHERE c.id IN ${idList(ids)}
         AND c.organization_id = ${scope.organizationId}
         AND c.session_id IS NULL
         AND c.archived_at IS NULL
      RETURNING c.id
    `);
    return rows.length;
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
        AND ${contentScope('lesson_resources', scope)}
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
      WHERE lesson_id = ${lessonId} AND ${contentScope('lesson_resources', scope)}
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
        AND ${contentScope('lesson_resources', scope)}
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
      WHERE id = ${courseId} AND ${contentScope('courses', scope)}
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
      WHERE cm.id = ${moduleId} AND ${contentScope('cm', scope)}
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
      WHERE l.id = ${lessonId} AND ${contentScope('l', scope)}
    `);
    return rows[0]?.session_id ?? null;
  }

  /**
   * Reads a course visible to this organization — its own, OR a global one
   * owned by the platform org (§3.4).
   *
   * Callers that MUTATE must follow this with
   * `CoursesService.assertNotGlobalContent`, which turns a platform-owned row
   * into a 422 explaining it is not theirs to edit. Returning 404 here instead
   * would be simpler but wrong: the admin can legitimately see the course in
   * their Content Library, so "not found" contradicts what is on their screen.
   */
  async findById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select()
      .from(courses)
      .where(
        and(
          eq(courses.id, id),
          inArray(courses.organizationId, [
            scope.organizationId,
            scope.platformOrganizationId,
          ]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * How many of THIS org's learners are on the course.
   *
   * Org-scoped, not content-scoped, for the reason spelled out beside
   * `enrollments_count` in `listWithStats` above: the course may be
   * platform-owned and shared, but an assignment is activity and belongs to
   * exactly one tenant. Unscoped here, the detail page's header would report a
   * different figure from the library card beside it.
   */
  async enrolledCount(scope: OrgScope, courseId: number): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM user_course_assignments uca
      WHERE uca.course_id = ${courseId} AND ${orgScope('uca', scope)}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /** Content: takes the OWNER's org — `scope.organizationId` for the admin creating it. */
  async createCourse(input: {
    organizationId: number;
    name: string;
    description: string | null;
    thumbnailUrl: string | null;
    isActive: boolean;
    category: string | null;
    isMandatory: boolean;
    expiryMonths: number | null;
    tags: string | null;
  }) {
    const [created] = await this.db
      .insert(courses)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        isActive: input.isActive ? 1 : 0,
        category: input.category,
        isMandatory: input.isMandatory ? 1 : 0,
        expiryMonths: input.expiryMonths,
        tags: input.tags,
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
      category: string | null;
      isMandatory: boolean;
      expiryMonths: number | null;
      tags: string | null;
    },
  ) {
    const [updated] = await this.db
      .update(courses)
      .set({
        name: input.name,
        description: input.description,
        thumbnailUrl: input.thumbnailUrl,
        isActive: input.isActive ? 1 : 0,
        category: input.category,
        isMandatory: input.isMandatory ? 1 : 0,
        expiryMonths: input.expiryMonths,
        tags: input.tags,
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
      WHERE cm.course_id = ${courseId} AND ${contentScope('cm', scope)}
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
        AND ${contentScope('l', scope)}
      ORDER BY l.sort_order, l.created_at
    `);
  }

  async nextModuleSortOrder(scope: OrgScope, courseId: number): Promise<number> {
    const rows = await this.db.all<{ m: number | null }>(sql`
      SELECT MAX(sort_order) AS m FROM course_modules
      WHERE course_id = ${courseId} AND ${contentScope('course_modules', scope)}
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
    input: {
      title: string;
      description: string | null;
      isActive: boolean;
      sortOrder: number;
    },
  ) {
    const [updated] = await this.db
      .update(courseModules)
      .set({
        title: input.title,
        description: input.description,
        isActive: input.isActive ? 1 : 0,
        // Modules carry a sort_order the Outline numbers them by, and
        // nothing could change it until now — the column existed, the DTO did
        // not. The service passes the current value when the caller omits it,
        // so an ordinary title edit cannot shuffle the course.
        sortOrder: input.sortOrder,
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
      WHERE module_id = ${moduleId} AND ${contentScope('lessons', scope)}
    `);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  /** Content: takes the OWNER's org — the caller supplies `organizationId`. */
  /**
   * Next sort order among a course's STAGED lessons (no module).
   *
   * Separate from `nextLessonSortOrder`, which orders within one module: a
   * staged lesson is not in a module, so there is nothing there to order it
   * against.
   */
  /**
   * Every lesson in a course, module-linked and staged alike, with the module
   * it sits in. One query — the authoring page shows both lists at once and
   * two reads would let them disagree mid-render.
   */
  async listCourseLessons(scope: OrgScope, courseId: number) {
    return this.db.all<Record<string, unknown> & { id: number }>(sql`
      SELECT l.*, cm.title AS module_title, cm.sort_order AS module_sort_order,
             (SELECT COUNT(*)::int FROM lesson_resources lr
               WHERE lr.lesson_id = l.id) AS resource_count,
             (SELECT COUNT(*)::int FROM assessments a
               WHERE a.lesson_id = l.id AND a.is_active = 1) AS assessment_count
      FROM lessons l
      LEFT JOIN course_modules cm ON cm.id = l.module_id
      WHERE l.course_id = ${courseId} AND ${orgScope('l', scope)}
      ORDER BY cm.sort_order NULLS FIRST, l.sort_order, l.id
    `);
  }

  /**
   * Link a lesson to a module, or unlink it (null).
   *
   * Scoped on BOTH the lesson and — when linking — the target module, so a
   * lesson cannot be moved into another tenant's module, and a module id from
   * another course is refused by the service before it reaches here.
   */
  async setLessonModule(
    scope: OrgScope,
    lessonId: number,
    moduleId: number | null,
    sortOrder: number,
  ) {
    const [updated] = await this.db
      .update(lessons)
      .set({ moduleId, sortOrder })
      .where(
        and(
          eq(lessons.id, lessonId),
          eq(lessons.organizationId, scope.organizationId),
        ),
      )
      .returning();
    return updated ?? null;
  }

  async nextCourseLessonSortOrder(
    scope: OrgScope,
    courseId: number,
  ): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COALESCE(MAX(l.sort_order), 0) + 1 AS n
      FROM lessons l
      WHERE l.course_id = ${courseId}
        AND l.module_id IS NULL
        AND ${orgScope('l', scope)}
    `);
    return Number(rows[0]?.n ?? 1);
  }

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
      WHERE cm.course_id = ${courseId} AND ${contentScope('cm', scope)}
        -- Defence in depth: the activity->content edge has no composite FK, so
        -- scope the package too rather than trusting the lesson link (§3.5).
        AND ${contentScope('sp', scope)}
    `);
  }

  /**
   * Narrows caller-supplied learner ids to this organization.
   *
   * The composite FK would reject a foreign id, but as a constraint violation:
   * one bad id fails the whole batch and the admin gets "Internal server
   * error" instead of a 404 that names the problem.
   */
  async filterLearnersInOrg(
    scope: OrgScope,
    userIds: number[],
  ): Promise<number[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM users
      WHERE id IN ${idList(userIds)} AND role = 'learner' AND ${orgScope('users', scope)}
    `);
    return rows.map((r) => Number(r.id));
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
      /**
       * A direct assignment CLEARS `source_journey_id`.
       *
       * The row may already exist because a journey put it there, in which
       * case it is gated by that journey's sequence. An admin assigning the
       * course by hand is deliberately opening it — that is the rule: a course
       * is never locked globally, only its position inside a journey is
       * (BACKEND_STRUCTURE.md §10.11). `DO NOTHING` left the journey's lock in
       * place and the admin's action silently did nothing.
       */
      .onConflictDoUpdate({
        target: [userCourseAssignments.userId, userCourseAssignments.courseId],
        set: { sourceJourneyId: null },
      })
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
    // Same rule as createAssignments above: assigning by hand opens the course.
    await this.db
      .insert(userCourseAssignments)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        courseId: input.courseId,
        assignedBy: input.assignedBy,
        dueDate: input.dueDate,
      })
      .onConflictDoUpdate({
        target: [userCourseAssignments.userId, userCourseAssignments.courseId],
        set: { sourceJourneyId: null },
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
