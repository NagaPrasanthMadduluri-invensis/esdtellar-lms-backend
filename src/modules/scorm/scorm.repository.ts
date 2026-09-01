import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import { DatabaseService } from '@/database/database.service';
import {
  scormPackages,
  userLessonCompletions,
  userScormAssignments,
} from '@/database/schema';

@Injectable()
export class ScormRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /* ── Admin ── */

  async listPackages(scope: OrgScope) {
    return this.db.all(sql`
      SELECT sp.*,
        (SELECT COUNT(*) FROM user_scorm_assignments
         WHERE package_id = sp.id) AS assigned_count,
        (SELECT COUNT(*) FROM scorm_tracking
         WHERE package_id = sp.id
           AND (lesson_status IN ('passed', 'completed')
                OR completion_status = 'completed')) AS completed_count,
        c.name AS course_name
      FROM scorm_packages sp
      LEFT JOIN courses c ON c.id = sp.course_id
      WHERE ${contentScope('sp', scope)}
      ORDER BY sp.created_at DESC
    `);
  }

  async findPackageWithCourse(scope: OrgScope, packageId: number) {
    const rows = await this.db.all(sql`
      SELECT sp.*, c.name AS course_name
      FROM scorm_packages sp
      LEFT JOIN courses c ON c.id = sp.course_id
      WHERE sp.id = ${packageId} AND ${contentScope('sp', scope)}
    `);
    return rows[0] ?? null;
  }

  async findPackage(scope: OrgScope, packageId: number) {
    const rows = await this.db
      .select({ id: scormPackages.id, packageDir: scormPackages.packageDir })
      .from(scormPackages)
      .where(
        and(
          eq(scormPackages.id, packageId),
          eq(scormPackages.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Roster for a package. The attempt count and best score come from correlated
   * subqueries rather than a second pass, so the admin list stays one round trip
   * however many learners are assigned (§7.1). Joining `scorm_packages` with
   * `scope` re-anchors the whole query to a package this admin actually owns.
   */
  async packageAssignments(scope: OrgScope, packageId: number) {
    return this.db.all(sql`
      SELECT usa.*, u.first_name, u.last_name, u.email, u.department,
             st.lesson_status, st.completion_status, st.score_raw,
             st.updated_at AS last_tracked,
             (SELECT COUNT(*) FROM scorm_attempts sa
               WHERE sa.user_id = usa.user_id AND sa.package_id = usa.package_id)
               AS attempt_count,
             (SELECT MAX(sa.percentage) FROM scorm_attempts sa
               WHERE sa.user_id = usa.user_id AND sa.package_id = usa.package_id)
               AS best_percentage,
             (SELECT MAX(sa.submitted_at) FROM scorm_attempts sa
               WHERE sa.user_id = usa.user_id AND sa.package_id = usa.package_id)
               AS last_submitted_at
      FROM user_scorm_assignments usa
      JOIN scorm_packages sp ON sp.id = usa.package_id
      JOIN users u ON u.id = usa.user_id
      LEFT JOIN scorm_tracking st
        ON st.user_id = usa.user_id AND st.package_id = usa.package_id
      WHERE usa.package_id = ${packageId} AND ${contentScope('sp', scope)}
      ORDER BY usa.assigned_at DESC
    `);
  }

  /* ── Attempts ── */

  /**
   * Appends one attempt. `attempt_number` is derived inside the statement so
   * the count and the insert cannot disagree, and no read is needed first.
   * `scorm_attempts` is activity — it takes the attempting LEARNER's own org,
   * which is `scope` here since the caller is that learner tracking their own
   * progress.
   */
  async appendAttempt(
    scope: OrgScope,
    values: {
      userId: number;
      packageId: number;
      scoreRaw: number | null;
      scoreMax: number | null;
      percentage: number | null;
      lessonStatus: string | null;
      completionStatus: string | null;
      successStatus: string | null;
      isPassed: number | null;
      totalTime: string | null;
      cmiData: string;
    },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO scorm_attempts
        (organization_id, user_id, package_id, attempt_number, score_raw, score_max,
         percentage, lesson_status, completion_status, success_status, is_passed,
         total_time, cmi_data, submitted_at)
      VALUES (
        ${scope.organizationId}, ${values.userId}, ${values.packageId},
        (SELECT COUNT(*) + 1 FROM scorm_attempts
          WHERE user_id = ${values.userId} AND package_id = ${values.packageId}),
        ${values.scoreRaw}, ${values.scoreMax}, ${values.percentage},
        ${values.lessonStatus}, ${values.completionStatus},
        ${values.successStatus}, ${values.isPassed},
        ${values.totalTime}, ${values.cmiData}, now()
      )
    `);
  }

  /** Every attempt one learner made on one package, newest first. */
  async listAttempts(scope: OrgScope, packageId: number, userId: number) {
    return this.db.all<{
      id: number;
      attempt_number: number;
      score_raw: number | null;
      score_max: number | null;
      percentage: number | null;
      lesson_status: string | null;
      completion_status: string | null;
      success_status: string | null;
      is_passed: number | null;
      total_time: string | null;
      cmi_data: string;
      submitted_at: string;
    }>(sql`
      SELECT id, attempt_number, score_raw, score_max, percentage,
             lesson_status, completion_status, success_status, is_passed,
             total_time, cmi_data, submitted_at
      FROM scorm_attempts
      WHERE package_id = ${packageId} AND user_id = ${userId}
        AND ${orgScope('scorm_attempts', scope)}
      ORDER BY attempt_number DESC
    `);
  }

  /**
   * Title/version for the attempts header. Separate from `findPackage`, which
   * selects only what the storage paths need and is deliberately narrow.
   */
  async findPackageSummary(scope: OrgScope, packageId: number) {
    const rows = await this.db
      .select({
        id: scormPackages.id,
        title: scormPackages.title,
        version: scormPackages.version,
      })
      .from(scormPackages)
      .where(
        and(
          eq(scormPackages.id, packageId),
          eq(scormPackages.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Name/email for the attempts header — the learner being inspected. */
  async findLearner(scope: OrgScope, userId: number) {
    const rows = await this.db.all<{
      id: number;
      first_name: string;
      last_name: string;
      email: string;
      department: string | null;
    }>(sql`
      SELECT id, first_name, last_name, email, department
      FROM users WHERE id = ${userId} AND ${orgScope('users', scope)}
    `);
    return rows[0] ?? null;
  }

  /** `scorm_packages` is content — it always takes the uploading admin's org. */
  async createPackage(
    scope: OrgScope,
    values: Omit<typeof scormPackages.$inferInsert, 'organizationId'>,
  ) {
    const [created] = await this.db
      .insert(scormPackages)
      .values({ ...values, organizationId: scope.organizationId })
      .returning();
    return created;
  }

  async deletePackage(scope: OrgScope, packageId: number): Promise<void> {
    await this.db
      .delete(scormPackages)
      .where(
        and(
          eq(scormPackages.id, packageId),
          eq(scormPackages.organizationId, scope.organizationId),
        ),
      );
  }

  async learnerIdsInDepartment(
    scope: OrgScope,
    department: string,
  ): Promise<number[]> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM users
      WHERE department = ${department} AND role = 'learner' AND is_active = 1
        AND ${orgScope('users', scope)}
    `);
    return rows.map((r) => Number(r.id));
  }

  /**
   * Restricts an admin-supplied list of learner ids to ones that actually
   * belong to `scope` — an id is untrusted input the moment it arrives in a
   * request body (§5.3), unlike `learnerIdsInDepartment`, which already reads
   * from `users` scoped.
   */
  async filterLearnersInOrg(
    scope: OrgScope,
    userIds: number[],
  ): Promise<number[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM users
      WHERE id = ANY(${userIds}) AND role = 'learner' AND ${orgScope('users', scope)}
    `);
    return rows.map((r) => Number(r.id));
  }

  /**
   * Bulk assign in ONE statement, returning how many rows were actually new.
   * The legacy handler issued an INSERT per learner inside a loop.
   *
   * `user_scorm_assignments` is activity — it takes the assigned LEARNER's own
   * org. Callers are expected to have already restricted `userIds` to `scope`
   * (`filterLearnersInOrg` / `learnerIdsInDepartment`), so `scope` here is what
   * is written, not re-validated.
   */
  async assignLearners(
    scope: OrgScope,
    packageId: number,
    userIds: number[],
    adminId: number,
  ): Promise<number> {
    if (userIds.length === 0) return 0;

    const result = await this.db
      .insert(userScormAssignments)
      .values(
        userIds.map((userId) => ({
          userId,
          packageId,
          assignedBy: adminId,
          organizationId: scope.organizationId,
        })),
      )
      .onConflictDoNothing();

    return result.rowCount ?? 0;
  }

  async unassignLearner(
    scope: OrgScope,
    packageId: number,
    userId: number,
  ): Promise<void> {
    await this.db
      .delete(userScormAssignments)
      .where(
        and(
          eq(userScormAssignments.packageId, packageId),
          eq(userScormAssignments.userId, userId),
          eq(userScormAssignments.organizationId, scope.organizationId),
        ),
      );
  }

  /* ── Learner ── */

  async listForLearner(scope: OrgScope, userId: number) {
    return this.db.all(sql`
      SELECT sp.id, sp.title, sp.version, sp.entry_point, sp.package_dir,
             sp.created_at, c.name AS course_name, usa.assigned_at,
             st.lesson_status, st.completion_status, st.success_status,
             st.score_raw, st.score_max, st.total_time,
             st.updated_at AS last_tracked
      FROM user_scorm_assignments usa
      JOIN scorm_packages sp ON sp.id = usa.package_id AND sp.is_active = 1
      LEFT JOIN courses c ON c.id = sp.course_id
      LEFT JOIN scorm_tracking st
        ON st.package_id = sp.id AND st.user_id = usa.user_id
      WHERE usa.user_id = ${userId} AND ${contentScope('sp', scope)}
      ORDER BY usa.assigned_at DESC
    `);
  }

  /**
   * A learner reaches a package either by direct assignment or because it is
   * embedded as a lesson in a course they are enrolled on.
   */
  async hasAccess(
    scope: OrgScope,
    userId: number,
    packageId: number,
  ): Promise<boolean> {
    const rows = await this.db.all<{ ok: number }>(sql`
      SELECT 1 AS ok FROM user_scorm_assignments
      WHERE user_id = ${userId} AND package_id = ${packageId}
        AND ${orgScope('user_scorm_assignments', scope)}
      UNION
      SELECT 1 AS ok FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      JOIN user_course_assignments uca ON uca.course_id = cm.course_id
      WHERE l.scorm_package_id = ${packageId} AND uca.user_id = ${userId}
        AND ${orgScope('uca', scope)}
      LIMIT 1
    `);
    return rows.length > 0;
  }

  async findAccessiblePackage(
    scope: OrgScope,
    userId: number,
    packageId: number,
  ) {
    const rows = await this.db.all(sql`
      SELECT sp.id, sp.title, sp.version, sp.entry_point, sp.package_dir,
             c.name AS course_name
      FROM scorm_packages sp
      LEFT JOIN courses c ON c.id = sp.course_id
      WHERE sp.id = ${packageId} AND sp.is_active = 1
        AND ${contentScope('sp', scope)}
        AND (
          EXISTS (SELECT 1 FROM user_scorm_assignments
                  WHERE user_id = ${userId} AND package_id = sp.id)
          OR EXISTS (
            SELECT 1 FROM lessons l
            JOIN course_modules cm ON cm.id = l.module_id
            JOIN user_course_assignments uca ON uca.course_id = cm.course_id
            WHERE l.scorm_package_id = sp.id AND uca.user_id = ${userId}
          )
        )
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async findTracking(scope: OrgScope, userId: number, packageId: number) {
    const rows = await this.db.all<{
      id: number;
      user_id: number;
      package_id: number;
      lesson_status: string | null;
      completion_status: string | null;
      success_status: string | null;
      score_raw: number | null;
      score_min: number | null;
      score_max: number | null;
      total_time: string | null;
      suspend_data: string | null;
      location: string | null;
      cmi_data: string;
      updated_at: string;
    }>(sql`
      SELECT id, user_id, package_id, lesson_status, completion_status,
             success_status, score_raw, score_min, score_max, total_time,
             suspend_data, location, cmi_data, updated_at
      FROM scorm_tracking
      WHERE user_id = ${userId} AND package_id = ${packageId}
        AND ${orgScope('scorm_tracking', scope)}
    `);
    return rows[0] ?? null;
  }

  /** `scorm_tracking` is activity — it takes the tracked LEARNER's own org. */
  async upsertTracking(
    scope: OrgScope,
    values: {
      userId: number;
      packageId: number;
      lessonStatus: string;
      completionStatus: string;
      successStatus: string;
      scoreRaw: number | null;
      scoreMax: number | null;
      totalTime: string | null;
      suspendData: string | null;
      location: string | null;
      cmiData: string;
    },
  ): Promise<void> {
    await this.db.run(sql`
      INSERT INTO scorm_tracking
        (organization_id, user_id, package_id, lesson_status, completion_status,
         success_status, score_raw, score_max, total_time, suspend_data,
         location, cmi_data, updated_at)
      VALUES (${scope.organizationId}, ${values.userId}, ${values.packageId},
              ${values.lessonStatus}, ${values.completionStatus},
              ${values.successStatus}, ${values.scoreRaw}, ${values.scoreMax},
              ${values.totalTime}, ${values.suspendData}, ${values.location},
              ${values.cmiData}, now())
      ON CONFLICT(user_id, package_id) DO UPDATE SET
        lesson_status     = excluded.lesson_status,
        completion_status = excluded.completion_status,
        success_status    = excluded.success_status,
        score_raw         = excluded.score_raw,
        score_max         = excluded.score_max,
        total_time        = excluded.total_time,
        suspend_data      = excluded.suspend_data,
        location          = excluded.location,
        cmi_data          = excluded.cmi_data,
        updated_at        = excluded.updated_at
    `);
  }

  /**
   * Entitlement check for authenticated SCORM static content
   * (`multi-tenancy.md` §3.9), keyed on `package_dir` because that is the URL
   * segment the request carries — not the numeric package id.
   *
   * Mirrors `hasAccess` above: a learner reaches a package two ways, a direct
   * `user_scorm_assignments` row OR the package embedded as a lesson in a
   * course they are assigned. `client/components/learner/lesson-content.jsx`
   * always launches the player from a lesson, so checking assignments alone
   * would 404 every course-embedded package. An admin previews without an
   * assignment, entitled to any active package IN THEIR OWN ORG — kept as its
   * own obvious branch rather than folded into the UNION.
   *
   * `scope` is minted by the CALLER (`ScormContentMiddleware`, which has no
   * `@CurrentScope()` — it resolves the verified token by hand and builds the
   * scope from `payload.organizationId` itself) rather than trusted from
   * anywhere else.
   */
  async isEntitledByPackageDir(
    scope: OrgScope,
    userId: number,
    packageDir: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    if (isAdmin) {
      const rows = await this.db.all<{ ok: number }>(sql`
        SELECT 1 AS ok FROM scorm_packages
        WHERE package_dir = ${packageDir} AND is_active = 1
          AND ${contentScope('scorm_packages', scope)}
        LIMIT 1
      `);
      return rows.length > 0;
    }

    const rows = await this.db.all<{ ok: number }>(sql`
      SELECT 1 AS ok
      FROM scorm_packages p
      JOIN user_scorm_assignments a
        ON a.package_id = p.id AND a.user_id = ${userId}
      WHERE p.package_dir = ${packageDir} AND p.is_active = 1
        AND ${contentScope('p', scope)}
      UNION
      SELECT 1 AS ok
      FROM scorm_packages p
      JOIN lessons l                   ON l.scorm_package_id = p.id
      JOIN course_modules cm           ON cm.id = l.module_id
      JOIN user_course_assignments uca ON uca.course_id = cm.course_id
      WHERE p.package_dir = ${packageDir} AND p.is_active = 1
        AND uca.user_id = ${userId}
        AND ${contentScope('p', scope)}
      LIMIT 1
    `);
    return rows.length > 0;
  }

  /** The lesson embedding this package for this learner, if any. */
  async findLinkedLesson(scope: OrgScope, userId: number, packageId: number) {
    const rows = await this.db.all<{ id: number; course_id: number }>(sql`
      SELECT l.id, cm.course_id FROM lessons l
      JOIN course_modules cm ON cm.id = l.module_id
      JOIN user_course_assignments uca ON uca.course_id = cm.course_id
      WHERE l.scorm_package_id = ${packageId} AND uca.user_id = ${userId}
        AND ${orgScope('uca', scope)}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** `user_lesson_completions` is activity — it takes the completing LEARNER's own org. */
  async markLessonComplete(
    scope: OrgScope,
    userId: number,
    lessonId: number,
  ): Promise<void> {
    await this.db
      .insert(userLessonCompletions)
      .values({ userId, lessonId, organizationId: scope.organizationId })
      .onConflictDoNothing();
  }
}
