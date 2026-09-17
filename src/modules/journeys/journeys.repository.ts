import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import { journeyCourses, journeyEnrollments, journeys } from '@/database/schema';

/** Raw-SQL row shape — snake_case, the same convention every sibling repository uses. */
export interface JourneySqlRow {
  id: number;
  organization_id: number;
  title: string;
  description: string | null;
  tag: string | null;
  skills: string | null;
  thumbnail_url: string | null;
  badge_label: string;
  badge_icon: string;
  points_bonus: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface JourneyStep {
  journeyCourseId: number;
  courseId: number;
  courseName: string;
  thumbnailUrl: string | null;
  sortOrder: number;
  isRequired: boolean;
  isComplete: boolean;
  /**
   * This learner's `user_course_assignments.source_journey_id` for this
   * course, or `null` when no assignment row exists at all (never assigned).
   * `NULL` on an existing row means "assigned directly" — always open (§4.3).
   */
  sourceJourneyId: number | null;
  hasAssignment: boolean;
}

/** Either the caller-supplied learner ids, or an active department's learners. */
export type LearnerMatch =
  | { kind: 'ids'; userIds: number[] }
  | { kind: 'department'; department: string };

/**
 * A parenthesised, comma-joined integer list for `IN (...)`, built as
 * individually-bound params rather than one array parameter.
 *
 * Interpolating a plain JS array straight into a `sql` template (`IN
 * (${ids})`) looks right but is NOT the same as `sql.join`: Drizzle's `sql`
 * tag treats a bare array value as a single bound parameter, which Postgres
 * then receives as one array-typed value rather than a list of scalars —
 * `id IN ($1)` with `$1 = {4,5}` fails at runtime ("operator does not exist:
 * integer = record"), because `IN` wants a list of scalars, not one array
 * value. `sql.join` is what actually produces `($1, $2)`.
 */
function idList(ids: number[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}::int`), sql`, `)})`;
}

@Injectable()
export class JourneysRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * The shared "is this course complete for this learner" rule
   * (`specs/learning-journeys.md` §4.1 — same definition
   * `CertificatesService.evaluate` applies): every active lesson complete, and
   * any ACTIVE assessment passed. Written as EXISTS/NOT EXISTS so it is a
   * single boolean expression that composes into a larger query rather than a
   * round trip of its own — every call site here uses it inside ONE
   * statement, never in a loop (§7.1, §7.2).
   */
  private courseCompleteExpr(courseIdExpr: SQL, userIdExpr: SQL): SQL {
    return sql`(
      EXISTS (
        SELECT 1 FROM lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        WHERE cm.course_id = ${courseIdExpr} AND l.is_active = 1 AND cm.is_active = 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM lessons l
        JOIN course_modules cm ON cm.id = l.module_id
        WHERE cm.course_id = ${courseIdExpr} AND l.is_active = 1 AND cm.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM user_lesson_completions ulc
            WHERE ulc.lesson_id = l.id AND ulc.user_id = ${userIdExpr}
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM assessments a
        WHERE a.course_id = ${courseIdExpr} AND a.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM user_assessment_attempts uaa
            WHERE uaa.assessment_id = a.id AND uaa.user_id = ${userIdExpr} AND uaa.is_passed = 1
          )
      )
    )`;
  }

  /* ── Content: journeys ── */

  /** Same shape as `createJourney`/`updateJourney` (Drizzle, camelCase) — `CoursesRepository.findById` is the precedent for reads widened to content scope. */
  async findById(scope: OrgScope, journeyId: number) {
    const rows = await this.db
      .select()
      .from(journeys)
      .where(
        and(
          eq(journeys.id, journeyId),
          inArray(journeys.organizationId, [
            scope.organizationId,
            scope.platformOrganizationId,
          ]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Paginated list with courses/learners counts, both correlated subqueries —
   * one query, no per-row follow-up (§7.1, §7.6).
   */
  async listForAdmin(
    scope: OrgScope,
    filters: {
      status?: 'active' | 'draft';
      archived?: boolean;
      limit: number;
      offset: number;
    },
  ) {
    const statusFilter =
      filters.status === 'active'
        ? sql`AND j.is_active = 1`
        : filters.status === 'draft'
          ? sql`AND j.is_active = 0`
          : sql``;

    // Archived and live are never mixed — the toggle swaps between two sets.
    // An archived path showing up in the builder's default view is the thing
    // archiving exists to prevent (§10.15, and 0019 said the same for courses).
    const archiveFilter = filters.archived
      ? sql`AND j.archived_at IS NOT NULL`
      : sql`AND j.archived_at IS NULL`;

    return this.db.all<
      JourneySqlRow & {
        courses_count: number;
        learners_count: number;
        completed_count: number;
        completion_pct: number;
        avg_score: number | null;
        archived_at: string | null;
      }
    >(sql`
      SELECT j.id, j.organization_id, j.title, j.description, j.tag, j.skills,
             j.thumbnail_url, j.badge_label, j.badge_icon, j.points_bonus,
             j.is_active, j.archived_at, j.created_at, j.updated_at,
             (SELECT COUNT(*) FROM journey_courses jc WHERE jc.journey_id = j.id) AS courses_count,
             -- ORG-SCOPED, unlike courses_count above it. A path is CONTENT and
             -- may be platform-owned (contentScope); an enrolment against it is
             -- ACTIVITY and belongs to exactly one tenant. §10.12 records what
             -- happens when a subquery forgets that.
             (SELECT COUNT(*) FROM journey_enrollments je
               WHERE je.journey_id = j.id AND ${orgScope('je', scope)}) AS learners_count,
             (SELECT COUNT(*) FROM journey_enrollments je2
               WHERE je2.journey_id = j.id AND je2.completed_at IS NOT NULL
                 AND ${orgScope('je2', scope)}) AS completed_count,
             -- Completion as a whole-number percentage, computed in SQL (§7.2)
             -- so the card and any future report read the same figure.
             COALESCE((
               SELECT ROUND(
                 COUNT(*) FILTER (WHERE je3.completed_at IS NOT NULL) * 100.0
                 / NULLIF(COUNT(*), 0)
               )::int
               FROM journey_enrollments je3
               WHERE je3.journey_id = j.id AND ${orgScope('je3', scope)}
             ), 0) AS completion_pct,
             -- Average best score across this org's learners on the path's
             -- courses. NULL when nobody has been scored — which the card
             -- renders as a dash rather than as 0%.
             (SELECT ROUND(AVG(a.percentage))::int
                FROM journey_courses jc2
                JOIN user_assessment_attempts a ON a.assessment_id IN (
                      SELECT ass.id FROM assessments ass WHERE ass.course_id = jc2.course_id)
               WHERE jc2.journey_id = j.id AND ${orgScope('a', scope)}) AS avg_score
      FROM journeys j
      WHERE ${contentScope('j', scope)} ${statusFilter} ${archiveFilter}
      ORDER BY j.created_at DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
  }

  /** How many archived paths this org has — the toggle's badge. */
  async archivedCount(scope: OrgScope): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM journeys j
      WHERE ${contentScope('j', scope)} AND j.archived_at IS NOT NULL
    `);
    return Number(rows[0]?.n ?? 0);
  }

  async countForAdmin(
    scope: OrgScope,
    filters: { status?: 'active' | 'draft'; archived?: boolean },
  ): Promise<number> {
    const statusFilter =
      filters.status === 'active'
        ? sql`AND j.is_active = 1`
        : filters.status === 'draft'
          ? sql`AND j.is_active = 0`
          : sql``;

    // Must mirror listForAdmin's filter exactly, or the pager counts a set the
    // list is not showing.
    const archiveFilter = filters.archived
      ? sql`AND j.archived_at IS NOT NULL`
      : sql`AND j.archived_at IS NULL`;

    const rows = await this.db.all<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total FROM journeys j
      WHERE ${contentScope('j', scope)} ${statusFilter} ${archiveFilter}
    `);
    return rows[0]?.total ?? 0;
  }

  /**
   * Bulk archive / restore.
   *
   * Scoped to `organization_id`, NOT `contentScope`: a platform-owned path is
   * readable by every tenant and must not be archivable by any of them. Same
   * predicate rule the course bulk endpoint follows (§10.12) — a request
   * naming ids that fail it simply affects fewer rows and reports the count,
   * rather than erroring on the first one.
   */
  async setArchived(
    scope: OrgScope,
    ids: number[],
    archived: boolean,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE journeys j
         SET archived_at = ${archived ? sql`now()` : sql`NULL`},
             updated_at = now()
       WHERE j.id IN ${idList(ids)}
         AND j.organization_id = ${scope.organizationId}
      RETURNING j.id
    `);
    return rows.length;
  }

  /**
   * Bulk activate / move to draft.
   *
   * Activating is refused for an archived path: publishing something that is
   * meant to be out of circulation contradicts the archive, and the two
   * controls would fight each other on the next render.
   */
  async setActive(
    scope: OrgScope,
    ids: number[],
    active: boolean,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const archivedGuard = active ? sql`AND j.archived_at IS NULL` : sql``;
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE journeys j
         SET is_active = ${active ? 1 : 0},
             updated_at = now()
       WHERE j.id IN ${idList(ids)}
         AND j.organization_id = ${scope.organizationId}
         ${archivedGuard}
      RETURNING j.id
    `);
    return rows.length;
  }

  /** Bulk delete. Org-owned only, for the reason `setArchived` gives. */
  async deleteMany(scope: OrgScope, ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.db.all<{ id: number }>(sql`
      DELETE FROM journeys j
       WHERE j.id IN ${idList(ids)}
         AND j.organization_id = ${scope.organizationId}
      RETURNING j.id
    `);
    return rows.length;
  }

  /** Ordered member courses for the admin detail/edit view. */
  async listCourses(scope: OrgScope, journeyId: number) {
    return this.db.all<{
      id: number;
      course_id: number;
      sort_order: number;
      is_required: number;
      course_name: string;
      thumbnail_url: string | null;
    }>(sql`
      SELECT jc.id, jc.course_id, jc.sort_order, jc.is_required,
             c.name AS course_name, c.thumbnail_url
      FROM journey_courses jc
      JOIN journeys j ON j.id = jc.journey_id
      JOIN courses c ON c.id = jc.course_id
      WHERE jc.journey_id = ${journeyId} AND ${contentScope('j', scope)}
      ORDER BY jc.sort_order ASC, jc.id ASC
    `);
  }

  /** `journeys` is content — takes the creating admin's own org (§3.1). */
  async createJourney(
    scope: OrgScope,
    values: Omit<typeof journeys.$inferInsert, 'organizationId'>,
  ): Promise<typeof journeys.$inferSelect> {
    const [created] = await this.db
      .insert(journeys)
      .values({ ...values, organizationId: scope.organizationId })
      .returning();
    return created;
  }

  async updateJourney(
    scope: OrgScope,
    journeyId: number,
    values: Partial<typeof journeys.$inferInsert>,
  ): Promise<typeof journeys.$inferSelect | null> {
    const [updated] = await this.db
      .update(journeys)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(
        and(eq(journeys.id, journeyId), eq(journeys.organizationId, scope.organizationId)),
      )
      .returning();
    return updated ?? null;
  }

  /** Cascades `journey_courses` and `journey_enrollments` via FK (spec §3.1, §3.3). */
  async deleteJourney(scope: OrgScope, journeyId: number): Promise<void> {
    await this.db
      .delete(journeys)
      .where(
        and(eq(journeys.id, journeyId), eq(journeys.organizationId, scope.organizationId)),
      );
  }

  /** Course ids that resolve inside this scope (content — org or platform). See `idList`. */
  async filterCoursesInScope(scope: OrgScope, courseIds: number[]): Promise<number[]> {
    if (courseIds.length === 0) return [];
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM courses WHERE id IN ${idList(courseIds)} AND ${contentScope('courses', scope)}
    `);
    return rows.map((r) => Number(r.id));
  }

  /**
   * Replaces the journey's whole course list in one transaction: delete then
   * bulk insert, rather than diffing — the admin form always resends the
   * complete ordered list, so a diff would just be a slower way to reach the
   * same rows.
   */
  async replaceCourses(
    scope: OrgScope,
    journeyId: number,
    items: { courseId: number; sortOrder: number; isRequired: boolean }[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(journeyCourses).where(eq(journeyCourses.journeyId, journeyId));
      if (items.length === 0) return;
      await tx.insert(journeyCourses).values(
        items.map((item) => ({
          organizationId: scope.organizationId,
          journeyId,
          courseId: item.courseId,
          sortOrder: item.sortOrder,
          isRequired: item.isRequired ? 1 : 0,
        })),
      );
    });
  }

  /* ── Learner-facing reads ── */

  /** One row per journey the learner is enrolled on; `assertCourseUnlocked` still checks per-course. */
  async findEnrollment(scope: OrgScope, userId: number, journeyId: number) {
    const rows = await this.db
      .select({ id: journeyEnrollments.id, completedAt: journeyEnrollments.completedAt })
      .from(journeyEnrollments)
      .where(
        and(
          eq(journeyEnrollments.userId, userId),
          eq(journeyEnrollments.journeyId, journeyId),
          eq(journeyEnrollments.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Every enrolled journey's progress, in ONE query with correlated
   * subqueries — the template is `CertificatesRepository.getCompletionSnapshot`
   * (spec §7.2): a query per journey here would be the same 24-round-trip
   * defect it fixed.
   */
  async listForLearner(
    scope: OrgScope,
    userId: number,
    pagination: { limit: number; offset: number },
  ) {
    const totalRequired = sql`(SELECT COUNT(*) FROM journey_courses jc
      WHERE jc.journey_id = j.id AND jc.is_required = 1)`;
    const completedRequired = sql`(SELECT COUNT(*) FROM journey_courses jc
      WHERE jc.journey_id = j.id AND jc.is_required = 1
        AND ${this.courseCompleteExpr(sql`jc.course_id`, sql`je.user_id`)})`;
    const nextCourseName = sql`(SELECT c2.name FROM journey_courses jc2
      JOIN courses c2 ON c2.id = jc2.course_id
      WHERE jc2.journey_id = j.id AND jc2.is_required = 1
        AND NOT ${this.courseCompleteExpr(sql`jc2.course_id`, sql`je.user_id`)}
      ORDER BY jc2.sort_order ASC LIMIT 1)`;

    return this.db.all<{
      enrollment_id: number;
      journey_id: number;
      title: string;
      description: string | null;
      tag: string | null;
      skills: string | null;
      thumbnail_url: string | null;
      badge_label: string;
      badge_icon: string;
      points_bonus: number;
      assigned_at: string;
      due_date: string | null;
      completed_at: string | null;
      total_required: number;
      completed_required: number;
      next_course_name: string | null;
    }>(sql`
      SELECT je.id AS enrollment_id, j.id AS journey_id, j.title, j.description,
             j.tag, j.skills, j.thumbnail_url, j.badge_label, j.badge_icon,
             j.points_bonus, je.assigned_at, je.due_date, je.completed_at,
             (${totalRequired}) AS total_required,
             (${completedRequired}) AS completed_required,
             (${nextCourseName}) AS next_course_name
      FROM journey_enrollments je
      JOIN journeys j ON j.id = je.journey_id
      WHERE je.user_id = ${userId} AND ${orgScope('je', scope)}
      ORDER BY je.assigned_at DESC
      LIMIT ${pagination.limit} OFFSET ${pagination.offset}
    `);
  }

  /**
   * Every course in a journey, in sequence, with the completion flag the
   * gating rule and the detail view both read. ONE query per journey — never
   * per course (spec §4.3, §7.2).
   */
  async getJourneySteps(
    scope: OrgScope,
    journeyId: number,
    userId: number,
  ): Promise<JourneyStep[]> {
    const rows = await this.db.all<{
      journey_course_id: number;
      course_id: number;
      course_name: string;
      thumbnail_url: string | null;
      sort_order: number;
      is_required: number;
      is_complete: boolean;
      source_journey_id: number | null;
      has_assignment: boolean;
    }>(sql`
      SELECT jc.id AS journey_course_id, jc.course_id, c.name AS course_name,
             c.thumbnail_url, jc.sort_order, jc.is_required,
             ${this.courseCompleteExpr(sql`jc.course_id`, sql`${userId}::int`)} AS is_complete,
             uca.source_journey_id, (uca.id IS NOT NULL) AS has_assignment
      FROM journey_courses jc
      JOIN journeys j ON j.id = jc.journey_id
      JOIN courses c ON c.id = jc.course_id
      LEFT JOIN user_course_assignments uca
        ON uca.course_id = jc.course_id AND uca.user_id = ${userId}
        AND uca.organization_id = ${scope.organizationId}
      WHERE jc.journey_id = ${journeyId} AND ${contentScope('j', scope)}
      ORDER BY jc.sort_order ASC, jc.id ASC
    `);

    return rows.map((row) => ({
      journeyCourseId: Number(row.journey_course_id),
      courseId: Number(row.course_id),
      courseName: row.course_name,
      thumbnailUrl: row.thumbnail_url,
      sortOrder: Number(row.sort_order),
      isRequired: Number(row.is_required) === 1,
      isComplete: Boolean(row.is_complete),
      sourceJourneyId: row.source_journey_id === null ? null : Number(row.source_journey_id),
      hasAssignment: Boolean(row.has_assignment),
    }));
  }

  /** The gating source for one learner's one course assignment — §4.3. */
  async findAssignmentSource(scope: OrgScope, userId: number, courseId: number) {
    const rows = await this.db.all<{ source_journey_id: number | null }>(sql`
      SELECT source_journey_id FROM user_course_assignments
      WHERE user_id = ${userId} AND course_id = ${courseId}
        AND organization_id = ${scope.organizationId}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /* ── Admin: per-journey learners ── */

  async listLearners(
    scope: OrgScope,
    journeyId: number,
    pagination: { limit: number; offset: number },
  ) {
    const totalRequired = sql`(SELECT COUNT(*) FROM journey_courses jc
      WHERE jc.journey_id = je.journey_id AND jc.is_required = 1)`;
    const completedRequired = sql`(SELECT COUNT(*) FROM journey_courses jc
      WHERE jc.journey_id = je.journey_id AND jc.is_required = 1
        AND ${this.courseCompleteExpr(sql`jc.course_id`, sql`je.user_id`)})`;
    const nextCourseName = sql`(SELECT c2.name FROM journey_courses jc2
      JOIN courses c2 ON c2.id = jc2.course_id
      WHERE jc2.journey_id = je.journey_id AND jc2.is_required = 1
        AND NOT ${this.courseCompleteExpr(sql`jc2.course_id`, sql`je.user_id`)}
      ORDER BY jc2.sort_order ASC LIMIT 1)`;

    return this.db.all<{
      enrollment_id: number;
      user_id: number;
      first_name: string;
      last_name: string;
      email: string;
      assigned_at: string;
      due_date: string | null;
      completed_at: string | null;
      total_required: number;
      completed_required: number;
      next_course_name: string | null;
    }>(sql`
      SELECT je.id AS enrollment_id, u.id AS user_id, u.first_name, u.last_name, u.email,
             je.assigned_at, je.due_date, je.completed_at,
             (${totalRequired}) AS total_required,
             (${completedRequired}) AS completed_required,
             (${nextCourseName}) AS next_course_name
      FROM journey_enrollments je
      JOIN users u ON u.id = je.user_id
      WHERE je.journey_id = ${journeyId} AND ${orgScope('je', scope)}
      ORDER BY u.first_name, u.last_name
      LIMIT ${pagination.limit} OFFSET ${pagination.offset}
    `);
  }

  async countLearners(scope: OrgScope, journeyId: number): Promise<number> {
    const rows = await this.db.all<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total FROM journey_enrollments je
      WHERE je.journey_id = ${journeyId} AND ${orgScope('je', scope)}
    `);
    return rows[0]?.total ?? 0;
  }

  /* ── Assignment (spec §4.1 acceptance 3, 4) ── */

  /** Narrows caller-supplied ids to real, active learners in this org. See `idList`. */
  async filterLearnersInOrg(scope: OrgScope, userIds: number[]): Promise<number[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM users
      WHERE id IN ${idList(userIds)} AND role = 'learner' AND is_active = 1
        AND ${orgScope('users', scope)}
    `);
    return rows.map((r) => Number(r.id));
  }

  async countActiveLearnersInDepartment(scope: OrgScope, department: string): Promise<number> {
    const rows = await this.db.all<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total FROM users u
      WHERE u.role = 'learner' AND u.is_active = 1 AND u.department = ${department}
        AND ${orgScope('u', scope)}
    `);
    return rows[0]?.total ?? 0;
  }

  private matchCondition(match: LearnerMatch, scope: OrgScope): SQL {
    const base = sql`u.role = 'learner' AND u.is_active = 1 AND ${orgScope('u', scope)}`;
    // Callers only reach here with a non-empty `userIds` (spec §4.1's
    // assign() returns early at `targetCount === 0`), so `idList` never sees
    // an empty list (see `idList` on why not a bare array or `ANY`).
    return match.kind === 'ids'
      ? sql`${base} AND u.id IN ${idList(match.userIds)}`
      : sql`${base} AND u.department = ${match.department}`;
  }

  /**
   * Enrolls every matching learner in ONE statement (spec §4.1 acceptance 3 —
   * no `await` inside a loop, the same shape as
   * `SessionsRepository.enrollDepartment`). Already-enrolled learners are
   * skipped by `UNIQUE(user_id, journey_id)` rather than filtered first.
   * Returns how many rows were newly created.
   */
  async enrollLearners(
    scope: OrgScope,
    journeyId: number,
    match: LearnerMatch,
    adminId: number,
    dueDate: string | null,
  ): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO journey_enrollments (organization_id, journey_id, user_id, assigned_by, due_date)
      SELECT u.organization_id, ${journeyId}, u.id, ${adminId}, ${dueDate}
      FROM users u
      WHERE ${this.matchCondition(match, scope)}
      ON CONFLICT (user_id, journey_id) DO NOTHING
      RETURNING id
    `);
    return rows.length;
  }

  /**
   * Assigns every member course to every matching learner in ONE statement.
   * `source_journey_id` is set on the new row; `ON CONFLICT DO NOTHING` means
   * a pre-existing direct assignment (source_journey_id NULL) is left
   * completely untouched — spec §3.5, §4.3, acceptance 4.
   */
  async assignJourneyCourses(
    scope: OrgScope,
    journeyId: number,
    match: LearnerMatch,
    adminId: number,
    dueDate: string | null,
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO user_course_assignments
        (organization_id, user_id, course_id, assigned_by, due_date, source_journey_id)
      SELECT u.organization_id, u.id, jc.course_id, ${adminId}, ${dueDate}, ${journeyId}
      FROM users u
      CROSS JOIN journey_courses jc
      WHERE ${this.matchCondition(match, scope)} AND jc.journey_id = ${journeyId}
      ON CONFLICT (user_id, course_id) DO NOTHING
    `);
  }

  async removeEnrollment(scope: OrgScope, journeyId: number, userId: number): Promise<void> {
    await this.db
      .delete(journeyEnrollments)
      .where(
        and(
          eq(journeyEnrollments.journeyId, journeyId),
          eq(journeyEnrollments.userId, userId),
          eq(journeyEnrollments.organizationId, scope.organizationId),
        ),
      );
  }

  /**
   * Withdraws only the course assignments THIS journey created
   * (`source_journey_id = journeyId`) — a pre-existing direct assignment
   * (NULL) is left alone, mirroring `SessionsRepository`'s roster removal.
   */
  async withdrawJourneyCourseAssignments(
    scope: OrgScope,
    journeyId: number,
    userId: number,
  ): Promise<void> {
    await this.db.run(sql`
      DELETE FROM user_course_assignments
      WHERE user_id = ${userId} AND source_journey_id = ${journeyId}
        AND organization_id = ${scope.organizationId}
    `);
  }

  /* ── Completion (spec §4.2) ── */

  /** Journeys this course belongs to, that this learner is on and has not finished. ONE query. */
  async findEnrolledJourneysContainingCourse(
    scope: OrgScope,
    userId: number,
    courseId: number,
  ): Promise<number[]> {
    const rows = await this.db.all<{ journey_id: number }>(sql`
      SELECT je.journey_id FROM journey_enrollments je
      JOIN journey_courses jc ON jc.journey_id = je.journey_id AND jc.course_id = ${courseId}
      WHERE je.user_id = ${userId} AND je.completed_at IS NULL
        AND ${orgScope('je', scope)}
    `);
    return rows.map((r) => Number(r.journey_id));
  }

  /**
   * Idempotent on purpose (spec acceptance 12): only stamps rows still open,
   * so replaying the trigger is a no-op the second time.
   */
  async markCompleted(scope: OrgScope, journeyId: number, userId: number): Promise<boolean> {
    const rows = await this.db.all<{ id: number }>(sql`
      UPDATE journey_enrollments SET completed_at = now()
      WHERE journey_id = ${journeyId} AND user_id = ${userId}
        AND completed_at IS NULL AND ${orgScope('journey_enrollments', scope)}
      RETURNING id
    `);
    return rows.length > 0;
  }
}
