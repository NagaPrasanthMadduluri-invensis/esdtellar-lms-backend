import { Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';

import type { RolePortal } from '@/common/permissions';
import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import { users } from '@/database/schema';

export interface LearnerListRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  department: string | null;
  location: string | null;
  job_role: string | null;
  job_level: string | null;
  is_active: number;
  created_at: string;
  assigned_courses: number;
}

/**
 * A row of the Manage Users directory — every account in the organization,
 * whatever portal it belongs to, with the progress figures the table shows.
 */
export interface DirectoryRow extends EmployeeAggregateRow {
  /** The portal selector: 'admin' | 'learner' | 'trainer'. */
  role: string;
  /** The RBAC role's label — Admin, Manager, Learner, Trainer. */
  role_label: string | null;
  role_id: number | null;
  manager_id: number | null;
  manager_name: string | null;
  reports_count: number;
  /** The role key, so the UI can style without matching on a display string. */
  role_key: string | null;
  /** Most recent lesson completion or assessment attempt. Null if neither. */
  last_activity: string | null;
}

export interface EmployeeAggregateRow extends LearnerListRow {
  total_lessons: number;
  completed_lessons: number;
  best_score: number | null;
  has_passed: number | null;
  attempt_count: number;
}

/**
 * The resolved, server-side query behind the Manage Users table. The service
 * turns the HTTP DTO into this (trimming blanks to `undefined`), so the
 * repository never sees an empty string that would match nothing.
 */
export interface DirectoryQuery {
  limit: number;
  offset: number;
  search?: string;
  status?: 'active' | 'inactive';
  progress?: 'completed' | 'failed' | 'in-progress' | 'not-started';
  department?: string;
  location?: string;
  jobRole?: string;
  jobLevel?: string;
  /** The RBAC role LABEL, matched against `roles.label`. */
  role?: string;
}

/** The KPI-tile counts, org-wide and independent of the table's filters. */
export interface DirectoryStatsRow {
  total: number;
  active: number;
  inactive: number;
  admins: number;
  learners: number;
  trainers: number;
  managers: number;
}

/** The distinct values the filter dropdowns offer, org-wide. */
export interface DirectoryFacetsRow {
  departments: string[] | null;
  locations: string[] | null;
  job_roles: string[] | null;
  job_levels: string[] | null;
  roles: string[] | null;
}

/** A lightweight identity row for the Manager picker and bulk resolution. */
export interface PickablePersonRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  is_active: number;
  role: string;
  role_label: string | null;
}

@Injectable()
export class UsersRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Learner list for the admin table. One query. */
  async listLearners(scope: OrgScope): Promise<LearnerListRow[]> {
    return this.db.all<LearnerListRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department,
             u.location, u.job_role, u.job_level, u.is_active, u.created_at,
             (SELECT COUNT(*) FROM user_course_assignments uca
              WHERE uca.user_id = u.id) AS assigned_courses
      FROM users u
      WHERE u.role = 'learner' AND ${orgScope('u', scope)}
      ORDER BY u.created_at DESC
    `);
  }

  /**
   * Employee list with progress and best score.
   *
   * The legacy handler ran three follow-up queries per learner inside a loop —
   * 19 learners cost 58 round trips. Correlated subqueries make it one.
   */
  async listEmployeesWithProgress(
    scope: OrgScope,
  ): Promise<EmployeeAggregateRow[]> {
    return this.db.all<EmployeeAggregateRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department,
             u.location, u.job_role, u.job_level, u.is_active, u.created_at,
             (SELECT COUNT(DISTINCT uca.course_id) FROM user_course_assignments uca
              WHERE uca.user_id = u.id) AS assigned_courses,
             (SELECT COUNT(*)
              FROM lessons l
              JOIN course_modules cm ON cm.id = l.module_id
              JOIN user_course_assignments uca
                ON uca.course_id = cm.course_id AND uca.user_id = u.id
              WHERE l.is_active = 1 AND cm.is_active = 1) AS total_lessons,
             (SELECT COUNT(*)
              FROM user_lesson_completions ulc
              JOIN lessons l ON l.id = ulc.lesson_id
              JOIN course_modules cm ON cm.id = l.module_id
              JOIN user_course_assignments uca
                ON uca.course_id = cm.course_id AND uca.user_id = u.id
              WHERE ulc.user_id = u.id) AS completed_lessons,
             (SELECT MAX(percentage) FROM user_assessment_attempts
              WHERE user_id = u.id) AS best_score,
             (SELECT MAX(is_passed) FROM user_assessment_attempts
              WHERE user_id = u.id) AS has_passed,
             (SELECT COUNT(*) FROM user_assessment_attempts
              WHERE user_id = u.id) AS attempt_count
      FROM users u
      WHERE u.role = 'learner' AND ${orgScope('u', scope)}
      ORDER BY u.created_at DESC
    `);
  }


  /**
   * The Manage Users directory: EVERY account in the organization, not just
   * learners.
   *
   * Deliberately a separate method from `listEmployeesWithProgress` rather
   * than a role filter on it. That one feeds the assign-learning picker and
   * the session roster, and both mean "people who can be given a course" —
   * widening it would have quietly offered admins and trainers as assignees.
   * Two callers, two questions, two methods.
   *
   * `role_label` comes from the RBAC role, not from `users.role`: the portal
   * selector collapses a Manager into `learner` (specs/rbac.md decision 2), so
   * a table rendering `users.role` would show four Managers as Learners and
   * give an admin no way to tell them apart.
   *
   * Still one query per page. The progress subqueries are the same correlated
   * pattern `listEmployeesWithProgress` uses (§7.1) and evaluate to 0 for an
   * account with no assignments, which is what an admin or trainer has.
   *
   * It is now PAGINATED (§7.6 — the directory was unbounded). The expensive
   * correlated subqueries run only for the page in the common case, because
   * `LIMIT`/`OFFSET` are applied at the `u` level BEFORE they are evaluated —
   * see `directoryBase`. The one exception is a `progress` filter, which needs
   * every matching row's derived status computed before it can be narrowed; it
   * is handled by wrapping the base and is the only path that pays per-row.
   */

  /**
   * The `u`-level filter predicate shared by the page query, the count and the
   * fast-path. Everything here filters on a column of `users` or the joined
   * `roles` row — cheap, indexable, and expressible without the progress
   * subqueries. The derived `progress` status is NOT here; see
   * `progressCondition`.
   */
  private directoryPredicate(scope: OrgScope, q: DirectoryQuery): SQL {
    const parts: SQL[] = [orgScope('u', scope)];
    if (q.search) {
      const like = `%${q.search}%`;
      // Name and email, matching what the box said it searched. `||` folds a
      // null middle away; first/last are NOT NULL so the concat is safe.
      parts.push(
        sql`((u.first_name || ' ' || u.last_name) ILIKE ${like} OR u.email ILIKE ${like})`,
      );
    }
    if (q.status === 'active') parts.push(sql`u.is_active = 1`);
    if (q.status === 'inactive') parts.push(sql`u.is_active = 0`);
    if (q.department) parts.push(sql`u.department = ${q.department}`);
    if (q.location) parts.push(sql`u.location = ${q.location}`);
    if (q.jobRole) parts.push(sql`u.job_role = ${q.jobRole}`);
    if (q.jobLevel) parts.push(sql`u.job_level = ${q.jobLevel}`);
    if (q.role) parts.push(sql`r.label = ${q.role}`);
    return sql.join(parts, sql` AND `);
  }

  /**
   * The derived-status filter, applied on the OUTER query's computed columns
   * (`has_passed`, `attempt_count`, `completed_lessons`). It mirrors
   * `UsersService.directory`'s own mapping exactly, so the filter and the chip
   * a row shows can never disagree. `1 = 1` when no progress filter is set.
   */
  private progressCondition(progress?: DirectoryQuery['progress']): SQL {
    if (!progress) return sql`1 = 1`;
    return sql`(CASE
      WHEN q.has_passed = 1 THEN 'completed'
      WHEN q.attempt_count > 0 THEN 'failed'
      WHEN q.completed_lessons > 0 THEN 'in-progress'
      ELSE 'not-started' END) = ${progress}`;
  }

  /**
   * The full directory SELECT, with the `u`-level predicate applied. When
   * `page` is given the ORDER BY and LIMIT/OFFSET are applied here, so the
   * correlated subqueries run only for the rows on the page. Without `page` it
   * is an unordered, unbounded set meant to be wrapped (the progress path).
   */
  private directoryBase(
    scope: OrgScope,
    q: DirectoryQuery,
    page?: { limit: number; offset: number },
  ): SQL {
    const paging = page
      ? sql` ORDER BY u.first_name, u.last_name, u.id LIMIT ${page.limit} OFFSET ${page.offset}`
      : sql``;
    return sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department,
             u.location, u.job_role, u.job_level, u.is_active, u.created_at,
             u.role,
             r.label AS role_label,
             r.key AS role_key,
             -- The role's ID, so the Change role dialog can preselect what
             -- they already hold. Without it the select opens blank and the
             -- admin cannot tell a no-op from a change.
             u.role_id AS role_id,
             u.manager_id AS manager_id,
             -- Denormalised for display, and LEFT so a person whose manager
             -- has been deleted still renders (ON DELETE SET NULL means the
             -- column is already null in that case, but the join must not
             -- drop the row either way).
             CASE WHEN m.id IS NULL THEN NULL
                  ELSE m.first_name || ' ' || m.last_name END AS manager_name,
             -- How many people report to THEM. Drives the "manages N but has
             -- no Manager role" flag: data recorded that nobody can see is
             -- the silent half of the screen-that-lies failure.
             (SELECT COUNT(*) FROM users d
               WHERE d.manager_id = u.id AND d.is_active = 1) AS reports_count,
             (SELECT COUNT(DISTINCT uca.course_id) FROM user_course_assignments uca
              WHERE uca.user_id = u.id) AS assigned_courses,
             (SELECT COUNT(*)
              FROM lessons l
              JOIN course_modules cm ON cm.id = l.module_id
              JOIN user_course_assignments uca
                ON uca.course_id = cm.course_id AND uca.user_id = u.id
              WHERE l.is_active = 1 AND cm.is_active = 1) AS total_lessons,
             (SELECT COUNT(*)
              FROM user_lesson_completions ulc
              JOIN lessons l ON l.id = ulc.lesson_id
              JOIN course_modules cm ON cm.id = l.module_id
              JOIN user_course_assignments uca
                ON uca.course_id = cm.course_id AND uca.user_id = u.id
              WHERE ulc.user_id = u.id) AS completed_lessons,
             (SELECT MAX(percentage) FROM user_assessment_attempts
              WHERE user_id = u.id) AS best_score,
             (SELECT MAX(is_passed) FROM user_assessment_attempts
              WHERE user_id = u.id) AS has_passed,
             (SELECT COUNT(*) FROM user_assessment_attempts
              WHERE user_id = u.id) AS attempt_count,
             -- Last ACTIVITY, not last login: there is no last_login column,
             -- and the table used to print created_at under this header, so
             -- every row claimed the person had been active on the day they
             -- joined. The latest thing they actually did is the honest
             -- answer, and null when they have done nothing.
             GREATEST(
               (SELECT MAX(ulc.completed_at) FROM user_lesson_completions ulc
                 WHERE ulc.user_id = u.id),
               (SELECT MAX(t.submitted_at) FROM user_assessment_attempts t
                 WHERE t.user_id = u.id)
             )::text AS last_activity
      FROM users u
      LEFT JOIN roles r
        ON r.id = u.role_id AND r.organization_id = u.organization_id
      LEFT JOIN users m ON m.id = u.manager_id
      WHERE ${this.directoryPredicate(scope, q)}${paging}
    `;
  }

  /** One page of the directory, filtered. */
  async listDirectoryPage(
    scope: OrgScope,
    q: DirectoryQuery,
  ): Promise<DirectoryRow[]> {
    if (q.progress) {
      // The derived status is not known until the subqueries have run, so the
      // whole matched set is computed, then narrowed, then paged.
      return this.db.all<DirectoryRow>(sql`
        SELECT * FROM (${this.directoryBase(scope, q)}) q
        WHERE ${this.progressCondition(q.progress)}
        ORDER BY q.first_name, q.last_name, q.id
        LIMIT ${q.limit} OFFSET ${q.offset}
      `);
    }
    // Fast path: page at the `u` level so the subqueries run only for the page.
    return this.db.all<DirectoryRow>(
      this.directoryBase(scope, q, { limit: q.limit, offset: q.offset }),
    );
  }

  /** The count of rows MATCHING the filters, for the pagination control. */
  async countDirectory(scope: OrgScope, q: DirectoryQuery): Promise<number> {
    if (q.progress) {
      const rows = await this.db.all<{ n: number }>(sql`
        SELECT count(*)::int AS n
          FROM (${this.directoryBase(scope, q)}) q
         WHERE ${this.progressCondition(q.progress)}
      `);
      return Number(rows[0]?.n ?? 0);
    }
    // No progress filter: the `u`-level predicate is enough, so the heavy
    // subqueries are never evaluated just to count.
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM users u
        LEFT JOIN roles r
          ON r.id = u.role_id AND r.organization_id = u.organization_id
       WHERE ${this.directoryPredicate(scope, q)}
    `);
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The KPI-tile counts, ORG-WIDE and independent of the table's filters: the
   * strip summarises the organization, not the current page. One aggregate
   * statement, so the tiles cannot cost five COUNT queries or disagree among
   * themselves (§10.12's instinct, now that the rows they used to be reduced
   * from are a single page rather than the whole set).
   */
  async directoryStats(scope: OrgScope): Promise<DirectoryStatsRow> {
    const rows = await this.db.all<DirectoryStatsRow>(sql`
      SELECT count(*)::int                                          AS total,
             count(*) FILTER (WHERE u.is_active = 1)::int           AS active,
             count(*) FILTER (WHERE u.is_active = 0)::int           AS inactive,
             count(*) FILTER (WHERE u.role = 'admin')::int          AS admins,
             count(*) FILTER (WHERE u.role = 'learner')::int        AS learners,
             count(*) FILTER (WHERE u.role = 'trainer')::int        AS trainers,
             count(*) FILTER (WHERE r.key = 'manager')::int         AS managers
        FROM users u
        LEFT JOIN roles r
          ON r.id = u.role_id AND r.organization_id = u.organization_id
       WHERE ${orgScope('u', scope)}
    `);
    return (
      rows[0] ?? {
        total: 0, active: 0, inactive: 0,
        admins: 0, learners: 0, trainers: 0, managers: 0,
      }
    );
  }

  /**
   * The distinct values the filter dropdowns offer, ORG-WIDE — so the options
   * do not shrink to whatever happens to be on the current page. One statement
   * of `array_agg(DISTINCT ...)`; nulls are stripped, order is left to the
   * service.
   */
  async directoryFacets(scope: OrgScope): Promise<DirectoryFacetsRow> {
    const rows = await this.db.all<DirectoryFacetsRow>(sql`
      SELECT array_remove(array_agg(DISTINCT u.department), NULL) AS departments,
             array_remove(array_agg(DISTINCT u.location),   NULL) AS locations,
             array_remove(array_agg(DISTINCT u.job_role),   NULL) AS job_roles,
             array_remove(array_agg(DISTINCT u.job_level),  NULL) AS job_levels,
             array_remove(array_agg(DISTINCT r.label),      NULL) AS roles
        FROM users u
        LEFT JOIN roles r
          ON r.id = u.role_id AND r.organization_id = u.organization_id
       WHERE ${orgScope('u', scope)}
    `);
    return (
      rows[0] ?? {
        departments: [], locations: [], job_roles: [], job_levels: [], roles: [],
      }
    );
  }

  /**
   * Every account in the org as a lightweight identity row, for the Manager
   * picker and the bulk-import manager resolution. Deliberately NOT a page:
   * a dropdown offering "everybody active except self" needs the whole set,
   * and this carries none of the correlated subqueries the directory does, so
   * it stays cheap even for a large org. The expensive progress table is what
   * is paginated; this is not.
   */
  async listPickablePeople(scope: OrgScope): Promise<PickablePersonRow[]> {
    return this.db.all<PickablePersonRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.is_active, u.role,
             r.label AS role_label
        FROM users u
        LEFT JOIN roles r
          ON r.id = u.role_id AND r.organization_id = u.organization_id
       WHERE ${orgScope('u', scope)}
       ORDER BY u.first_name, u.last_name
    `);
  }

  async findRoleById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(
        and(eq(users.id, id), eq(users.organizationId, scope.organizationId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findLearnerProfile(scope: OrgScope, id: number) {
    const rows = await this.db
      .select({
        id: users.id,
        first_name: users.firstName,
        last_name: users.lastName,
        email: users.email,
        department: users.department,
        location: users.location,
        job_role: users.jobRole,
        job_level: users.jobLevel,
        is_active: users.isActive,
        created_at: users.createdAt,
      })
      .from(users)
      .where(
        and(
          eq(users.id, id),
          eq(users.role, 'learner'),
          eq(users.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Deliberately NOT org-scoped. `users.email` is globally UNIQUE (spec
   * decision 1: one email = one organization), so an address already taken in
   * another organization is still unavailable here. Scoping this would let an
   * admin pass the check and then hit the database's unique constraint — a 500
   * where the caller expects a clean 409.
   */
  /**
   * Which of these addresses are already registered, in ONE query.
   *
   * DELIBERATELY NOT org-scoped, exactly like `emailExists` beside it: an
   * email is the global login identity, so a learner cannot be created
   * with an address another tenant already uses. Scoping this would let
   * two organizations register the same address and the second one could
   * never sign in — the row would exist and the login lookup would find
   * the first.
   *
   * Returns lower-cased values, because the caller compares against a
   * lower-cased DTO field and a Set comparison does no normalising of its
   * own.
   */
  async existingEmails(emails: string[]): Promise<Set<string>> {
    if (emails.length === 0) return new Set();
    const rows = await this.db
      .select({ email: users.email })
      .from(users)
      .where(inArray(users.email, emails));
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }

  async emailExists(email: string, excludeId?: number): Promise<boolean> {
    const where = excludeId
      ? and(eq(users.email, email), ne(users.id, excludeId))
      : eq(users.email, email);

    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(where)
      .limit(1);
    return rows.length > 0;
  }

  /**
   * A candidate manager: active, in the caller's organization, with their own
   * manager so the cycle walk can start one step up.
   *
   * Org-scoped in SQL rather than checked afterwards, so a manager id from
   * another tenant returns nothing and the service 404s it.
   */
  async findManagerCandidate(scope: OrgScope, userId: number) {
    const rows = await this.db.all<{
      id: number;
      first_name: string;
      last_name: string;
      manager_id: number | null;
    }>(sql`
      SELECT u.id, u.first_name, u.last_name, u.manager_id
        FROM users u
       WHERE u.id = ${userId} AND ${orgScope('u', scope)} AND u.is_active = 1
    `);
    return rows[0] ?? null;
  }

  /** One step up the reporting chain. Null ends the walk. */
  async managerOf(scope: OrgScope, userId: number) {
    const rows = await this.db.all<{ manager_id: number | null }>(sql`
      SELECT u.manager_id FROM users u
       WHERE u.id = ${userId} AND ${orgScope('u', scope)}
    `);
    const next = rows[0]?.manager_id;
    return next === null || next === undefined ? null : Number(next);
  }

  /**
   * `roleId` is REQUIRED and is the organization's `learner` role, resolved by
   * the service before this is called.
   *
   * It used to be absent, and `users.role_id` is NOT NULL since
   * `migrate-rbac.mjs` ran — so every call returned a not-null violation as a
   * 500 and an admin could not add an employee at all (`specs/rbac.md` §3.4).
   * `role` and `role_id` are now written together from one resolved role row,
   * which is the only way an INSERT can satisfy both the constraint and the
   * denormalisation rule in §8.3.
   */
  /**
   * Resolve a set of email addresses to ACTIVE users of one organization.
   *
   * For the bulk import's manager column. One statement for the whole file
   * rather than a lookup per row (§7.1) — a 500-row upload naming forty
   * distinct managers costs one round trip, not five hundred.
   *
   * `organizationId` is in the predicate, so an address belonging to another
   * tenant resolves to nothing at all. That is what keeps the manager column
   * from becoming a cross-tenant write through a spreadsheet: the caller
   * cannot tell "no such person" from "not yours", and does not need to.
   *
   * ACTIVE only, matching the picker in the Add User form. A deactivated
   * account cannot sign in to read Team Learning, so pointing reports at one
   * records a line nobody can follow.
   */
  async activeByEmails(
    organizationId: number,
    emails: string[],
  ): Promise<{ id: number; email: string; first_name: string; last_name: string }[]> {
    if (emails.length === 0) return [];
    return this.db
      .select({
        id: users.id,
        email: users.email,
        first_name: users.firstName,
        last_name: users.lastName,
      })
      .from(users)
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.isActive, 1),
          inArray(users.email, emails),
        ),
      );
  }

  async createLearner(
    scope: OrgScope,
    input: {
      employeeId?: string | null;
      firstName: string;
      lastName: string;
      email: string;
      passwordHash: string;
      department: string | null;
      location: string | null;
      jobRole: string | null;
      jobLevel: string | null;
      managerId?: number | null;
      roleId: number;
      role: RolePortal;
      /**
       * Set the "owed a welcome email" marker in THIS insert, so the intent
       * is recorded atomically with the learner and cannot be lost in the
       * window before the batched enqueue (0044, §10.33). The bulk importer
       * passes the admin's checkbox; every other caller leaves it false.
       */
      welcomePending?: boolean;
    },
  ) {
    const [created] = await this.db
      .insert(users)
      .values({
        // A learner is created in the org of the admin creating them. There is
        // no other org an admin could legitimately place a user into: their
        // OrgScope is the only organization they can see.
        organizationId: scope.organizationId,
        employeeId: input.employeeId ?? null,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        password: input.passwordHash,
        role: input.role,
        roleId: input.roleId,
        department: input.department,
        location: input.location,
        jobRole: input.jobRole,
        jobLevel: input.jobLevel,
        managerId: input.managerId ?? null,
        welcomePendingSince: input.welcomePending ? new Date() : null,
      })
      .returning({
        id: users.id,
        first_name: users.firstName,
        last_name: users.lastName,
        email: users.email,
        is_active: users.isActive,
        created_at: users.createdAt,
      });
    return created;
  }

  async updateProfile(
    scope: OrgScope,
    id: number,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      department: string | null;
      location: string | null;
      jobRole: string | null;
      jobLevel: string | null;
      managerId: number | null;
    },
  ) {
    const [updated] = await this.db
      .update(users)
      .set({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        department: input.department,
        location: input.location,
        jobRole: input.jobRole,
        jobLevel: input.jobLevel,
        managerId: input.managerId,
      })
      .where(
        and(eq(users.id, id), eq(users.organizationId, scope.organizationId)),
      )
      .returning({
        id: users.id,
        first_name: users.firstName,
        last_name: users.lastName,
        email: users.email,
        department: users.department,
        location: users.location,
        job_role: users.jobRole,
        job_level: users.jobLevel,
        manager_id: users.managerId,
        is_active: users.isActive,
      });
    return updated;
  }

  async setActive(scope: OrgScope, id: number, isActive: boolean) {
    const [updated] = await this.db
      .update(users)
      .set({ isActive: isActive ? 1 : 0 })
      .where(
        and(eq(users.id, id), eq(users.organizationId, scope.organizationId)),
      )
      .returning({
        id: users.id,
        first_name: users.firstName,
        last_name: users.lastName,
        email: users.email,
        is_active: users.isActive,
      });
    return updated;
  }

  async remove(scope: OrgScope, id: number): Promise<void> {
    await this.db
      .delete(users)
      .where(
        and(eq(users.id, id), eq(users.organizationId, scope.organizationId)),
      );
  }

  /* ── Learner detail: assignments + progress + assessments ──
     Four set-based queries total, regardless of how many courses the learner
     has. The legacy handler nested loops per course AND per module, so a
     learner with 5 courses of 4 modules cost roughly 40 round trips. */

  async findAssignedCourses(userId: number) {
    return this.db.all<{
      course_id: number;
      assigned_at: string;
      course_name: string;
      description: string | null;
    }>(sql`
      SELECT uca.course_id, uca.assigned_at, c.name AS course_name, c.description
      FROM user_course_assignments uca
      JOIN courses c ON c.id = uca.course_id AND c.is_active = 1
      WHERE uca.user_id = ${userId}
      ORDER BY uca.assigned_at DESC
    `);
  }

  /** Lesson totals and completions for EVERY assigned course, in one query. */
  async lessonProgressByCourse(userId: number) {
    return this.db.all<{
      course_id: number;
      total_lessons: number;
      completed_lessons: number;
    }>(sql`
      SELECT cm.course_id,
             COUNT(l.id) AS total_lessons,
             COUNT(ulc.id) AS completed_lessons
      FROM course_modules cm
      JOIN lessons l ON l.module_id = cm.id AND l.is_active = 1
      LEFT JOIN user_lesson_completions ulc
        ON ulc.lesson_id = l.id AND ulc.user_id = ${userId}
      WHERE cm.is_active = 1
        AND cm.course_id IN (
          SELECT course_id FROM user_course_assignments WHERE user_id = ${userId}
        )
      GROUP BY cm.course_id
    `);
  }

  /** Assessments across all assigned courses, with this learner's stats. */
  async assessmentsForAssignedCourses(userId: number) {
    return this.db.all<{
      id: number;
      course_id: number;
      title: string;
      passing_score: number;
      questions_count: number;
      attempt_count: number;
      best_score: number | null;
      has_passed: number | null;
    }>(sql`
      SELECT a.id, a.course_id, a.title, a.passing_score,
             (SELECT COUNT(*) FROM assessment_questions q
              WHERE q.assessment_id = a.id) AS questions_count,
             (SELECT COUNT(*) FROM user_assessment_attempts t
              WHERE t.assessment_id = a.id AND t.user_id = ${userId}) AS attempt_count,
             (SELECT MAX(percentage) FROM user_assessment_attempts t
              WHERE t.assessment_id = a.id AND t.user_id = ${userId}) AS best_score,
             (SELECT MAX(is_passed) FROM user_assessment_attempts t
              WHERE t.assessment_id = a.id AND t.user_id = ${userId}) AS has_passed
      FROM assessments a
      WHERE a.is_active = 1
        AND a.course_id IN (
          SELECT course_id FROM user_course_assignments WHERE user_id = ${userId}
        )
      ORDER BY a.created_at
    `);
  }

  /** Every attempt for the learner; grouped by assessment in the service. */
  /**
   * SCORM packages sitting inside this learner's assigned courses, with the
   * same roll-up the assessment query produces so the admin view can render
   * both the same way.
   *
   * A package reaches a course two ways: embedded as a lesson
   * (`lessons.scorm_package_id`), or attached directly via
   * `scorm_packages.course_id`. Both are covered, and `DISTINCT` collapses a
   * package that is embedded in more than one lesson of the same course.
   */
  async scormPackagesForAssignedCourses(scope: OrgScope, userId: number) {
    return this.db.all<{
      id: number;
      course_id: number;
      title: string;
      version: string;
      attempt_count: number;
      best_percentage: number | null;
      has_passed: number | null;
    }>(sql`
      SELECT DISTINCT sp.id, cm.course_id, sp.title, sp.version,
             (SELECT COUNT(*) FROM scorm_attempts sa
              WHERE sa.package_id = sp.id AND sa.user_id = ${userId})
               AS attempt_count,
             (SELECT MAX(percentage) FROM scorm_attempts sa
              WHERE sa.package_id = sp.id AND sa.user_id = ${userId})
               AS best_percentage,
             (SELECT MAX(is_passed) FROM scorm_attempts sa
              WHERE sa.package_id = sp.id AND sa.user_id = ${userId})
               AS has_passed
      FROM scorm_packages sp
      JOIN lessons l ON l.scorm_package_id = sp.id AND l.is_active = 1
      JOIN course_modules cm ON cm.id = l.module_id AND cm.is_active = 1
      WHERE sp.is_active = 1
        -- scorm_packages is a query ROOT here, reached over the
        -- activity->content edge that no composite FK guards (§3.5). Without
        -- this predicate another org's package title and version leak into
        -- this response.
        AND ${contentScope('sp', scope)}
        AND cm.course_id IN (
          SELECT course_id FROM user_course_assignments WHERE user_id = ${userId}
        )

      UNION

      SELECT DISTINCT sp.id, sp.course_id AS course_id, sp.title, sp.version,
             (SELECT COUNT(*) FROM scorm_attempts sa
              WHERE sa.package_id = sp.id AND sa.user_id = ${userId})
               AS attempt_count,
             (SELECT MAX(percentage) FROM scorm_attempts sa
              WHERE sa.package_id = sp.id AND sa.user_id = ${userId})
               AS best_percentage,
             (SELECT MAX(is_passed) FROM scorm_attempts sa
              WHERE sa.package_id = sp.id AND sa.user_id = ${userId})
               AS has_passed
      FROM scorm_packages sp
      WHERE sp.is_active = 1 AND sp.course_id IS NOT NULL
        AND sp.course_id IN (
          SELECT course_id FROM user_course_assignments WHERE user_id = ${userId}
        )
    `);
  }

  /** Every SCORM attempt this learner made inside their assigned courses. */
  async scormAttemptsForAssignedCourses(userId: number) {
    return this.db.all<{
      id: number;
      package_id: number;
      attempt_number: number;
      score_raw: number | null;
      score_max: number | null;
      percentage: number | null;
      is_passed: number | null;
      lesson_status: string | null;
      total_time: string | null;
      submitted_at: string;
    }>(sql`
      SELECT sa.id, sa.package_id, sa.attempt_number, sa.score_raw,
             sa.score_max, sa.percentage, sa.is_passed, sa.lesson_status,
             sa.total_time, sa.submitted_at
      FROM scorm_attempts sa
      WHERE sa.user_id = ${userId}
      ORDER BY sa.submitted_at DESC
    `);
  }

  async attemptsForAssignedCourses(userId: number) {
    return this.db.all<{
      id: number;
      assessment_id: number;
      score: number;
      total_questions: number;
      percentage: number;
      is_passed: number;
      submitted_at: string;
    }>(sql`
      SELECT t.id, t.assessment_id, t.score, t.total_questions,
             t.percentage, t.is_passed, t.submitted_at
      FROM user_assessment_attempts t
      JOIN assessments a ON a.id = t.assessment_id AND a.is_active = 1
      WHERE t.user_id = ${userId}
        AND a.course_id IN (
          SELECT course_id FROM user_course_assignments WHERE user_id = ${userId}
        )
      ORDER BY t.submitted_at DESC
    `);
  }
}
