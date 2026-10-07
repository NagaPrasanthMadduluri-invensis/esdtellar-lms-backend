import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { hashPassword } from '@/common/crypto/password.util';
import { PasswordResetService } from '@/modules/auth/password-reset.service';
import {
  OptionNotOfferedError,
  OrgOptionsService,
} from '@/modules/org-options/org-options.service';
import { RolesService } from '@/modules/roles/roles.service';
import { ActivityService } from '@/modules/activity/activity.service';
import { SeatsService } from '@/modules/seats/seats.service';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import type {
  BulkCreateUsersDto,
  CreateUserDto,
  UpdateUserDto,
} from './dto/user.dto';
import type { OrgScope } from '@/database/org-scope';

import { UsersRepository } from './users.repository';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { actorLabel } from '@/common/notifications';

/** Applied to bulk-imported learners who arrive without a password column. */
const DEFAULT_BULK_PASSWORD = 'Edstellar@123';

@Injectable()
export class UsersService {
  constructor(
    private readonly repository: UsersRepository,
    /**
     * Injected for one reason: `users.role_id` is NOT NULL, so creating a
     * learner has to resolve this organization's `learner` role first
     * (`specs/rbac.md` §3.4). The SERVICE is injected, never
     * `RolesRepository` — `BACKEND_STRUCTURE.md` §3.2.
     */
    private readonly roles: RolesService,
    /**
     * For the welcome email's set-password link. The SERVICE, never its
     * repository (§3.2) — and the same one the forgot-password flow uses,
     * so there is exactly one way a one-time credential gets minted.
     */
    private readonly passwordReset: PasswordResetService,
    /**
     * Best-effort recording for the dashboard's Recent Activity panel. Every
     * call is fire-and-forget by contract (`ActivityService.record` never
     * throws), so no write here is wrapped in a try/catch of its own.
     */
    private readonly activity: ActivityService,
    /**
     * The seat limit. Injected so `create` and `setActive` can refuse before
     * writing — the check that makes a limit real rather than a number on a
     * screen. The SERVICE, never the repository (§3.2).
     */
    private readonly seats: SeatsService,
    /** Best-effort (§8.4) — `notify` cannot throw. */
    private readonly notifications: NotificationsService,
    /** The per-tenant branch locations and job levels that replaced
     *  `common/workforce.ts` (`0031`). */
    private readonly orgOptions: OrgOptionsService,
  ) {}

  async listLearners(scope: OrgScope) {
    return { users: await this.repository.listLearners(scope) };
  }

  async listEmployees(scope: OrgScope) {
    const rows = await this.repository.listEmployeesWithProgress(scope);

    return {
      employees: rows.map((row) => {
        const total = Number(row.total_lessons);
        const completed = Number(row.completed_lessons);
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

        const attemptCount = Number(row.attempt_count);
        const hasPassed = Number(row.has_passed) === 1;

        let status: string;
        if (hasPassed) status = 'completed';
        else if (attemptCount > 0) status = 'failed';
        else if (completed > 0) status = 'in-progress';
        else status = 'not-started';

        return {
          id: row.id,
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          department: row.department,
          location: row.location ?? null,
          job_role: row.job_role ?? null,
          job_level: row.job_level ?? null,
          is_active: Number(row.is_active) === 1,
          created_at: row.created_at,
          assigned_courses: Number(row.assigned_courses),
          progress,
          status,
          score: row.best_score !== null ? Math.round(Number(row.best_score)) : null,
        };
      }),
    };
  }


  /**
   * The Manage Users directory — every account in the organization, plus the
   * KPI tiles above the table.
   *
   * The counts are derived from the rows already fetched rather than from five
   * `COUNT(*)` queries beside them (§7.2 in spirit): the table always renders
   * every row, so the numbers are a reduce over data that is already here, and
   * a separate query could disagree with the list beneath it.
   *
   * `can_manage` is the important field. `assertMutableLearner` refuses to
   * edit or delete anything but a learner, so an admin or trainer row must
   * show those actions DISABLED rather than let a click return 403 — a control
   * that is enabled and always fails is the screen-that-lies failure
   * BACKEND_STRUCTURE §5.2.1 exists to prevent. The API is still what enforces
   * it; this only stops the UI offering what it knows will be refused.
   */
  async directory(scope: OrgScope) {
    const rows = await this.repository.listDirectory(scope);

    const users = rows.map((row) => {
      const total = Number(row.total_lessons);
      const completed = Number(row.completed_lessons);
      const attemptCount = Number(row.attempt_count);
      const hasPassed = Number(row.has_passed) === 1;

      let status: string;
      if (hasPassed) status = 'completed';
      else if (attemptCount > 0) status = 'failed';
      else if (completed > 0) status = 'in-progress';
      else status = 'not-started';

      return {
        id: row.id,
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        department: row.department,
        location: row.location ?? null,
        job_role: row.job_role ?? null,
        job_level: row.job_level ?? null,
        role: row.role,
        role_key: row.role_key ?? row.role,
        role_label: row.role_label ?? titleCase(row.role),
        role_id: row.role_id !== null ? Number(row.role_id) : null,
        manager_id: row.manager_id !== null ? Number(row.manager_id) : null,
        manager_name: row.manager_name ?? null,
        reports_count: Number(row.reports_count ?? 0),
        is_active: Number(row.is_active) === 1,
        created_at: row.created_at,
        last_activity: row.last_activity,
        assigned_courses: Number(row.assigned_courses),
        progress: total > 0 ? Math.round((completed / total) * 100) : 0,
        status,
        score: row.best_score !== null ? Math.round(Number(row.best_score)) : null,
        can_manage: row.role === 'learner',
      };
    });

    const by = (predicate: (u: (typeof users)[number]) => boolean) =>
      users.filter(predicate).length;

    return {
      users,
      stats: {
        total: users.length,
        active: by((u) => u.is_active),
        inactive: by((u) => !u.is_active),
        admins: by((u) => u.role === 'admin'),
        learners: by((u) => u.role === 'learner'),
        trainers: by((u) => u.role === 'trainer'),
        // Managers ride in the learner portal (rbac.md decision 2), so they
        // are counted in `learners` above too. Surfaced separately because an
        // admin looking at this table can otherwise not tell they exist.
        managers: by((u) => u.role_key === 'manager'),
      },
    };
  }

  /**
   * Adds an employee to the admin's own organization, on that organization's
   * `learner` role.
   *
   * The role is resolved BEFORE the insert because `users.role_id` is NOT NULL
   * (`specs/rbac.md` §3.4) — without it this endpoint returned a 500 from a
   * not-null violation, which is what "Add User" did from the moment RBAC
   * landed until this was fixed.
   *
   * A learner is the only thing this creates. Putting the new user on a
   * different role is a second, explicit step — `PATCH /admin/users/:id/role`,
   * which the Add User dialog calls straight afterwards — so that
   * `RolesService.assign` stays the one method that MOVES a user between
   * roles (§8.3) and the one that decides which portal they land in.
   */
  async create(scope: OrgScope, dto: CreateUserDto, actor?: AuthenticatedUser) {
    if (await this.repository.emailExists(dto.email)) {
      throw new ConflictException('Email already in use');
    }

    /*
     * WHICH role, and therefore whether this costs a seat.
     *
     * Omitted means `learner`, which is what every caller sent before the Add
     * User dialog grew a role selector and what the bulk import still sends.
     *
     * The seat check runs ONLY for a learner-portal role. A seat is an active
     * learner (`0028_seat_limits.sql`) — an organization should never have to
     * choose between an extra trainer and an extra learner — so checking it
     * for a trainer would refuse an account that consumes nothing. Equally,
     * skipping it for a learner would make the cap decoration (§10.17).
     */
    const role = dto.role_id
      ? await this.roles.roleForAssignment(scope, dto.role_id)
      : await this.roles.roleByKey(scope, 'learner');

    if (role.portal === 'learner') {
      await this.seats.assertSeatAvailable(scope);
    }

    const workforce = await this.resolveWorkforceFields(scope, dto);
    // No subjectId: a row that does not exist yet cannot be in anybody's chain.
    const managerId = await this.assertManager(scope, dto.manager_id);

    const user = await this.repository.createLearner(scope, {
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      passwordHash: hashPassword(dto.password),
      department: dto.department ?? null,
      location: workforce.location,
      jobRole: dto.job_role ?? null,
      jobLevel: workforce.jobLevel,
      managerId,
      roleId: role.id,
      // Derived from the role, never assumed to be the string 'learner' — if
      // an organization ever points its `learner` key at another portal, the
      // portal selector follows the role rather than contradicting it.
      role: role.portal,
    });

    await this.activity.record(scope, {
      type: 'user_created',
      detail: `Added ${dto.first_name} ${dto.last_name} (${role.label.toLowerCase()}${
        dto.department ? `, ${dto.department}` : ''
      })`,
      actor: actor ?? null,
      subjectType: 'user',
      subjectId: user.id,
    });

    /*
     * Tell the org's OTHER admins, not the one who just did it.
     *
     * `exceptUserId` matters more here than anywhere else: onboarding is
     * usually a run of ten or twenty in a sitting, and an admin whose own bell
     * lights up twenty times learns within a day to ignore it — at which
     * point every other notification is lost too.
     */
    /*
     * The learner's own welcome, with a link to choose a password.
     *
     * Not the temporary password itself: the outbox keeps every body for
     * 90 days, so mailing it would put a plaintext credential in a
     * database table and leave it in their inbox for good. The temporary
     * password still exists and the admin can still read it out — this
     * only changes what travels by email.
     *
     * Best-effort and unawaited (§8.4). The account is created either
     * way, and the admin has the password on screen if the mail fails.
     */
    void this.passwordReset.sendWelcome({
      id: user.id,
      email: dto.email,
      organizationId: scope.organizationId,
      firstName: dto.first_name ?? null,
    });

    void (async () => {
      void this.notifications.notify({
        userIds: await this.notifications.adminsOf(scope.organizationId),
        organizationId: scope.organizationId,
        type: 'learner_onboarded',
        title: `${dto.first_name} ${dto.last_name} was onboarded`,
        body: dto.department
          ? `Added to ${dto.department}. They can sign in now.`
          : 'They can sign in now.',
        link: '/admin/users',
        subjectType: 'user',
        subjectId: user.id,
        actorName: actorLabel(actor),
        exceptUserId: actor?.userId ?? null,
      });
    })();

    return { user };
  }

  async update(scope: OrgScope, userId: number, dto: UpdateUserDto) {
    await this.assertMutableLearner(scope, userId);

    if (await this.repository.emailExists(dto.email, userId)) {
      throw new ConflictException('Email is already in use by another account');
    }

    const workforce = await this.resolveWorkforceFields(scope, dto);
    const managerId = await this.assertManager(scope, dto.manager_id, userId);

    const updated = await this.repository.updateProfile(scope, userId, {
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      department: dto.department ?? null,
      location: workforce.location,
      jobRole: dto.job_role ?? null,
      jobLevel: workforce.jobLevel,
      managerId,
    });

    return { user: { ...updated, is_active: updated.is_active === 1 } };
  }

  async setActive(
    scope: OrgScope,
    userId: number,
    isActive: boolean,
    actor?: AuthenticatedUser,
  ) {
    await this.assertMutableLearner(scope, userId);

    // Reactivating consumes a seat, so it is checked too — otherwise an admin
    // at the cap could deactivate one learner and reactivate two.
    // Deactivating never is: freeing a seat must always be possible.
    if (isActive) await this.seats.assertSeatAvailable(scope);
    const updated = await this.repository.setActive(scope, userId, isActive);

    await this.activity.record(scope, {
      type: isActive ? 'user_reactivated' : 'user_deactivated',
      detail: `${isActive ? 'Reactivated' : 'Deactivated'} ${updated.first_name} ${updated.last_name}`,
      actor: actor ?? null,
      subjectType: 'user',
      subjectId: userId,
    });

    return { user: { ...updated, is_active: updated.is_active === 1 } };
  }

  async remove(scope: OrgScope, userId: number) {
    await this.assertMutableLearner(scope, userId, 'Cannot delete admin accounts');
    await this.repository.remove(scope, userId);
    return { message: 'User deleted' };
  }

  /**
   * Full learner report: assigned courses, per-course progress, assessments
   * and every attempt. Assembled from four set-based queries.
   */
  async getLearnerDetail(scope: OrgScope, userId: number) {
    // Scoped: an id belonging to another organization resolves to null here and
    // becomes a 404, so the six detail queries below never run for a foreign
    // user. They are anchored on this validated userId and inherit its tenancy
    // — scoping each of them again would be noise (spec §3.3).
    const user = await this.repository.findLearnerProfile(scope, userId);
    if (!user) throw new NotFoundException('User not found');

    const [
      assignments,
      progressRows,
      assessmentRows,
      attemptRows,
      scormRows,
      scormAttemptRows,
    ] = await Promise.all([
      this.repository.findAssignedCourses(userId),
      this.repository.lessonProgressByCourse(userId),
      this.repository.assessmentsForAssignedCourses(userId),
      this.repository.attemptsForAssignedCourses(userId),
      this.repository.scormPackagesForAssignedCourses(scope, userId),
      this.repository.scormAttemptsForAssignedCourses(userId),
    ]);

    const progressByCourse = new Map(
      progressRows.map((row) => [Number(row.course_id), row]),
    );

    const attemptsByAssessment = new Map<number, typeof attemptRows>();
    for (const attempt of attemptRows) {
      const key = Number(attempt.assessment_id);
      const list = attemptsByAssessment.get(key);
      if (list) list.push(attempt);
      else attemptsByAssessment.set(key, [attempt]);
    }

    const assessmentsByCourse = new Map<number, unknown[]>();
    for (const assessment of assessmentRows) {
      const attempts = attemptsByAssessment.get(Number(assessment.id)) ?? [];
      const entry = {
        id: assessment.id,
        title: assessment.title,
        passing_score: assessment.passing_score,
        questions_count: Number(assessment.questions_count),
        attempt_count: Number(assessment.attempt_count),
        best_score:
          assessment.best_score !== null ? Number(assessment.best_score) : null,
        has_passed: Number(assessment.has_passed) === 1,
        attempts,
      };

      const key = Number(assessment.course_id);
      const list = assessmentsByCourse.get(key);
      if (list) list.push(entry);
      else assessmentsByCourse.set(key, [entry]);
    }

    // SCORM packages get the same treatment as assessments: grouped by course,
    // each carrying its own attempt list, so one card can render both without
    // the UI needing to know which kind it is looking at.
    const scormAttemptsByPackage = new Map<number, typeof scormAttemptRows>();
    for (const attempt of scormAttemptRows) {
      const key = Number(attempt.package_id);
      const list = scormAttemptsByPackage.get(key);
      if (list) list.push(attempt);
      else scormAttemptsByPackage.set(key, [attempt]);
    }

    const scormByCourse = new Map<number, unknown[]>();
    for (const pkg of scormRows) {
      const entry = {
        id: pkg.id,
        title: pkg.title,
        version: pkg.version,
        attempt_count: Number(pkg.attempt_count),
        best_score:
          pkg.best_percentage !== null ? Number(pkg.best_percentage) : null,
        // null when the package only reports completion and never grades —
        // which must not render the same as "failed".
        has_passed: pkg.has_passed === null ? null : Number(pkg.has_passed) === 1,
        attempts: (scormAttemptsByPackage.get(Number(pkg.id)) ?? []).map(
          (attempt) => ({
            id: attempt.id,
            attempt_number: attempt.attempt_number,
            score_raw: attempt.score_raw,
            score_max: attempt.score_max,
            percentage: attempt.percentage,
            is_passed:
              attempt.is_passed === null ? null : attempt.is_passed === 1,
            lesson_status: attempt.lesson_status,
            total_time: attempt.total_time,
            submitted_at: attempt.submitted_at,
          }),
        ),
      };

      const key = Number(pkg.course_id);
      const list = scormByCourse.get(key);
      if (list) list.push(entry);
      else scormByCourse.set(key, [entry]);
    }

    const courses = assignments.map((assignment) => {
      const courseId = Number(assignment.course_id);
      const progress = progressByCourse.get(courseId);
      const totalLessons = Number(progress?.total_lessons ?? 0);
      const completedLessons = Number(progress?.completed_lessons ?? 0);

      return {
        course_id: courseId,
        course_name: assignment.course_name,
        assigned_at: assignment.assigned_at,
        totalLessons,
        completedLessons,
        progress:
          totalLessons > 0
            ? Math.round((completedLessons / totalLessons) * 100)
            : 0,
        assessments: (assessmentsByCourse.get(courseId) ?? []) as {
          has_passed: boolean;
          attempts: { percentage: number }[];
        }[],
        scorm_packages: (scormByCourse.get(courseId) ?? []) as {
          has_passed: boolean | null;
          attempts: { percentage: number | null }[];
        }[],
      };
    });

    const allAttempts = courses.flatMap((course) =>
      course.assessments.flatMap((assessment) => assessment.attempts),
    );
    const passedAssessments = courses
      .flatMap((course) => course.assessments)
      .filter((assessment) => assessment.has_passed).length;

    return {
      user: { ...user, is_active: Number(user.is_active) === 1 },
      summary: {
        coursesAssigned: courses.length,
        coursesCompleted: courses.filter((course) => course.progress === 100)
          .length,
        totalAttempts: allAttempts.length,
        passedAssessments,
        bestScore:
          allAttempts.length > 0
            ? Math.max(...allAttempts.map((attempt) => Number(attempt.percentage)))
            : null,
      },
      courses,
    };
  }

  /**
   * Per-row validation, so one bad row never rejects the whole upload —
   * the caller gets a `failed` array naming the row number and reason.
   */
  async bulkCreate(scope: OrgScope, dto: BulkCreateUsersDto) {
    let created = 0;
    const failed: { row: number; email: string; reason: string }[] = [];
    const welcomeTargets: {
      id: number;
      email: string;
      organizationId: number;
      firstName: string;
    }[] = [];

    // Resolved ONCE, outside the loop: a query per row would be an N+1 on the
    // one endpoint that is deliberately row-at-a-time (§7.1). If the
    // organization has no learner role this throws before any row is
    // attempted, which is right — every row would otherwise land in `failed`
    // with a generic reason and the real cause never shown.
    const learnerRole = await this.roles.roleByKey(scope, 'learner');

    /*
     * The branch locations and job levels, fetched ONCE for the file.
     *
     * `assertLocation` / `assertJobLevel` each run a query and each returns
     * the SAME list on every row, so a 500-row upload was re-reading two
     * identical lists a thousand times between them — the N+1 §7.1 forbids.
     * This endpoint's "deliberately row-at-a-time" licence is about
     * REPORTING a bad row without rejecting the file; it never licensed
     * re-reading a constant set. The returned checkers apply the identical
     * rule and throw the identical `OptionNotOfferedError`, because they
     * share one matcher with the single-row asserters.
     */
    const options = await this.orgOptions.optionCheckers(scope.organizationId);

    /*
     * Every address already registered, in ONE query rather than a probe
     * per row.
     *
     * It is a mutable Set, not a snapshot, and that is load-bearing: a
     * file containing the same address TWICE must fail the second row,
     * and with a pre-fetched snapshot alone it would not — the first row
     * inserts, the second checks a stale set, and the unique index throws
     * a bare "Database error" instead of "Email already registered". So
     * each successful insert adds to it, the same shape `managerByEmail`
     * uses just below.
     */
    const taken = await this.repository.existingEmails(
      dto.users
        .map((row) => row.email?.trim().toLowerCase())
        .filter((email): email is string => !!email),
    );

    /*
     * THE MANAGER COLUMN, resolved ONCE for the whole file.
     *
     * The spreadsheet carries an EMAIL, because that is the only identifier
     * an admin can type that is guaranteed to mean one person — a name
     * column would attach somebody's reports to the wrong Priya and say
     * nothing about it. The browser resolves the same address back to a NAME
     * in the preview, so what the admin confirms is the human one.
     *
     * One query for every distinct address in the file, not one per row
     * (§7.1): a 500-row import naming forty managers costs one round trip.
     * `activeByEmails` carries the organization in its predicate, so an
     * address belonging to another tenant simply resolves to nothing.
     */
    const managerEmails = [
      ...new Set(
        dto.users
          .map((row) => row.manager?.trim().toLowerCase())
          .filter((email): email is string => !!email),
      ),
    ];
    const managerByEmail = new Map<string, number>();
    for (const found of await this.repository.activeByEmails(
      scope.organizationId,
      managerEmails,
    )) {
      managerByEmail.set(found.email.toLowerCase(), found.id);
    }

    for (const [index, row] of dto.users.entries()) {
      const rowNum = index + 1;
      const email = row.email ?? '';
      const password = row.password?.trim() || DEFAULT_BULK_PASSWORD;

      if (!row.first_name) {
        failed.push({ row: rowNum, email: email || '—', reason: 'First name is required' });
        continue;
      }
      if (!row.last_name) {
        failed.push({ row: rowNum, email: email || '—', reason: 'Last name is required' });
        continue;
      }
      if (!email) {
        failed.push({ row: rowNum, email: '—', reason: 'Email is required' });
        continue;
      }
      if (password.length < 6) {
        failed.push({ row: rowNum, email, reason: 'Password must be at least 6 characters' });
        continue;
      }
      if (taken.has(email)) {
        failed.push({ row: rowNum, email, reason: 'Email already registered' });
        continue;
      }

      /*
       * A CSV reaches this loop without the validation the admin form has, so
       * the lists are enforced here or not at all — an import is exactly how a
       * location nobody can filter on got into the table the first time.
       *
       * The valid set is now this ORGANIZATION's branch locations and job
       * levels rather than a constant (`0031`), so the check is a service call
       * and the failure reason names that tenant's own options. A bad row
       * fails with the valid values in the reason, so the admin fixes the CSV
       * rather than discovering months later that these learners are missing
       * from every location report.
       *
       * Matching is case-insensitive and the STORED value is the list's
       * spelling, which is what the alias table used to do for
       * Bengaluru/Bangalore and now happens for every value automatically.
       */
      let location: string | null;
      let jobLevel: string | null;
      try {
        location = options.location(row.location ?? null);
      } catch (error) {
        failed.push({
          row: rowNum,
          email,
          reason:
            error instanceof OptionNotOfferedError
              ? error.message
              : 'Location could not be validated',
        });
        continue;
      }
      try {
        jobLevel = options.jobLevel(row.job_level ?? null);
      } catch (error) {
        failed.push({
          row: rowNum,
          email,
          reason:
            error instanceof OptionNotOfferedError
              ? error.message
              : 'Job level could not be validated',
        });
        continue;
      }

      /*
       * BLANK IS A VALID ROW and always will be: most learners have no
       * manager recorded, and an import that refused them would be an
       * import nobody could use.
       *
       * An address that does not resolve is a different thing and FAILS the
       * row. The admin typed it, so it was meant; importing the learner
       * without it would leave somebody their manager cannot see in Team
       * Learning, discovered weeks later by the manager wondering where
       * their report went. Same instinct as the location and job level
       * checks above — name what is wrong while the CSV is still open.
       */
      let managerId: number | null = null;
      const managerEmail = row.manager?.trim().toLowerCase() ?? '';
      if (managerEmail) {
        if (managerEmail === email) {
          failed.push({
            row: rowNum,
            email,
            reason: 'A person cannot be their own manager',
          });
          continue;
        }
        managerId = managerByEmail.get(managerEmail) ?? null;
        if (managerId === null) {
          failed.push({
            row: rowNum,
            email,
            reason:
              `No active user with the email ${managerEmail} in this `
              + 'organization. Add the manager first, or list them higher up '
              + 'in this file, or leave the column blank.',
          });
          continue;
        }
      }

      try {
        const createdUser = await this.repository.createLearner(scope, {
          employeeId: row.employee_id ?? null,
          firstName: row.first_name,
          lastName: row.last_name,
          email,
          passwordHash: hashPassword(password),
          department: row.department ?? null,
          location,
          jobRole: row.job_role ?? null,
          jobLevel,
          managerId,
          roleId: learnerRole.id,
          role: learnerRole.portal,
        });
        created++;
        /*
         * Collected rather than emailed here. One `sendWelcome` per row is
         * two round trips per person — 1,000 for a 500-row file, inside the
         * request, on the path that already runs `scryptSync` per row. The
         * batch after the loop is a fixed handful whatever the size (§7.1).
         */
        /* So a second row naming the same address fails on the line above
         * rather than on the unique index. */
        taken.add(email);
        if (createdUser?.id) {
          welcomeTargets.push({
            id: createdUser.id,
            email,
            organizationId: scope.organizationId,
            firstName: row.first_name,
          });
        }
        /*
         * A person created by THIS file can be named as a manager by a row
         * BELOW them, which is how an admin onboards a team in one upload.
         *
         * A cycle is impossible by construction rather than by a check: a
         * manager has to already exist at the moment their report's row is
         * processed, and rows are processed in order. A pair that names each
         * other simply fails the first row, and then the second.
         */
        if (createdUser?.id) managerByEmail.set(email, createdUser.id);
      } catch {
        failed.push({ row: rowNum, email, reason: 'Database error — could not insert' });
      }
    }

    /*
     * AFTER the loop, and AWAITED rather than voided.
     *
     * Awaiting costs one `issueMany` plus one enqueue per 100 — a handful
     * of statements, not a send — and buys the admin a truthful number on
     * the results screen. Voiding it would make `welcome_emails_queued` a
     * guess, and the whole reason this exists is that the previous answer
     * to "were they emailed?" was silence.
     *
     * `sendWelcomeMany` never throws (§8.4): the accounts are already
     * created and committed, and an email failure must not turn a
     * successful import into an error. A failure is visible afterwards on
     * the Email Delivery page (§10.32), which is the other half of this.
     */
    const welcomeRequested = dto.send_welcome_email !== false;
    const welcomeEmailsQueued =
      welcomeRequested && welcomeTargets.length > 0
        ? await this.passwordReset.sendWelcomeMany(welcomeTargets)
        : 0;

    return {
      created,
      failed,
      total: dto.users.length,
      /*
       * Three fields rather than one, because "we did not try" and "we
       * tried and nothing went out" are different facts with different
       * next steps — the first is the admin's own checkbox, the second is
       * a suppression, an allowlist or a broken transport.
       */
      welcome_emails_requested: welcomeRequested,
      welcome_emails_queued: welcomeEmailsQueued,
    };
  }

  /** Admin accounts are not editable or deletable through this API. */
  private async assertMutableLearner(
    scope: OrgScope,
    userId: number,
    message = 'Cannot modify admin accounts',
  ): Promise<void> {
    const user = await this.repository.findRoleById(scope, userId);
    if (!user) throw new NotFoundException('User not found');
    if (user.role === 'admin') throw new ForbiddenException(message);
  }

  /**
   * Resolve `location` and `job_level` against THIS organization's curated
   * lists, returning the list's own spelling.
   *
   * One helper for create, update and the bulk importer, so a value the form
   * accepts cannot be one the CSV rejects. Throws 422 with the tenant's own
   * valid values — the check the DTO's `@IsIn` used to do before `0031` made
   * the valid set a per-tenant query (§3: a rule that needs data is the
   * service's, not a decorator's).
   */
  /**
   * Validate a proposed manager, returning the id to store.
   *
   * Three refusals, and the third is the one that needs a query rather than a
   * constraint:
   *
   *   - **not themselves.** A person who reports to themselves is their own
   *     team, and Team Learning would list them looking at their own record.
   *   - **same organization, active.** A manager from another tenant would
   *     put one tenant's learning data on another tenant's screen — the
   *     cross-tenant leak §10.12 records, through a column instead of a join.
   *     404 rather than 403, so an id from another org is indistinguishable
   *     from one that does not exist.
   *   - **no cycle.** A manages B, B manages A: neither can be listed without
   *     listing the other, and any code walking the chain loops forever. A
   *     CHECK can express `manager_id <> id` and cannot express this, so both
   *     live here rather than half in each place.
   *
   * `subjectId` is the person being edited — absent when creating, because a
   * row that does not exist yet cannot be in anybody's chain.
   */
  private async assertManager(
    scope: OrgScope,
    managerId: number | null | undefined,
    subjectId?: number,
  ): Promise<number | null> {
    if (managerId === null || managerId === undefined) return null;
    if (!Number.isInteger(managerId) || managerId <= 0) {
      throw new UnprocessableEntityException('manager_id must be a user id');
    }
    if (subjectId && managerId === subjectId) {
      throw new UnprocessableEntityException(
        'Somebody cannot be their own manager.',
      );
    }

    const manager = await this.repository.findManagerCandidate(
      scope,
      managerId,
    );
    if (!manager) throw new NotFoundException('Manager not found');

    if (subjectId) {
      // Walk UP from the proposed manager. If we reach the person being
      // edited, this edit would close a loop. Bounded by MAX_CHAIN so a cycle
      // that somehow already exists cannot hang the request.
      const MAX_CHAIN = 50;
      let cursor: number | null = manager.manager_id;
      for (let i = 0; cursor !== null && i < MAX_CHAIN; i += 1) {
        if (cursor === subjectId) {
          throw new UnprocessableEntityException(
            `${manager.first_name} ${manager.last_name} already reports to ` +
              'this person, directly or through somebody else. A reporting ' +
              'line cannot form a loop.',
          );
        }
        cursor = await this.repository.managerOf(scope, cursor);
      }
    }

    return managerId;
  }

  private async resolveWorkforceFields(
    scope: OrgScope,
    dto: { location?: string | null; job_level?: string | null },
  ): Promise<{ location: string | null; jobLevel: string | null }> {
    try {
      const [location, jobLevel] = await Promise.all([
        this.orgOptions.assertLocation(scope.organizationId, dto.location),
        this.orgOptions.assertJobLevel(scope.organizationId, dto.job_level),
      ]);
      return { location, jobLevel };
    } catch (error) {
      throw new UnprocessableEntityException(
        error instanceof Error ? error.message : 'Invalid value',
      );
    }
  }

}

/** `admin` -> `Admin`. Only a fallback for a user whose role row is missing. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
