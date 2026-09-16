import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { hashPassword } from '@/common/crypto/password.util';
import {
  JOB_LEVELS,
  LOCATION_ALIASES,
  LOCATIONS,
} from '@/common/workforce';
import { RolesService } from '@/modules/roles/roles.service';
import { ActivityService } from '@/modules/activity/activity.service';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import type {
  BulkCreateUsersDto,
  CreateUserDto,
  UpdateUserDto,
} from './dto/user.dto';
import type { OrgScope } from '@/database/org-scope';

import { UsersRepository } from './users.repository';

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
     * Best-effort recording for the dashboard's Recent Activity panel. Every
     * call is fire-and-forget by contract (`ActivityService.record` never
     * throws), so no write here is wrapped in a try/catch of its own.
     */
    private readonly activity: ActivityService,
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

    const learnerRole = await this.roles.roleByKey(scope, 'learner');

    const user = await this.repository.createLearner(scope, {
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      passwordHash: hashPassword(dto.password),
      department: dto.department ?? null,
      location: dto.location ?? null,
      jobRole: dto.job_role ?? null,
      jobLevel: dto.job_level ?? null,
      roleId: learnerRole.id,
      // Derived from the role, never assumed to be the string 'learner' — if
      // an organization ever points its `learner` key at another portal, the
      // portal selector follows the role rather than contradicting it.
      role: learnerRole.portal,
    });

    await this.activity.record(scope, {
      type: 'user_created',
      detail: `Added ${dto.first_name} ${dto.last_name} (learner${
        dto.department ? `, ${dto.department}` : ''
      })`,
      actor: actor ?? null,
      subjectType: 'user',
      subjectId: user.id,
    });

    return { user };
  }

  async update(scope: OrgScope, userId: number, dto: UpdateUserDto) {
    await this.assertMutableLearner(scope, userId);

    if (await this.repository.emailExists(dto.email, userId)) {
      throw new ConflictException('Email is already in use by another account');
    }

    const updated = await this.repository.updateProfile(scope, userId, {
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      department: dto.department ?? null,
      location: dto.location ?? null,
      jobRole: dto.job_role ?? null,
      jobLevel: dto.job_level ?? null,
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

    // Resolved ONCE, outside the loop: a query per row would be an N+1 on the
    // one endpoint that is deliberately row-at-a-time (§7.1). If the
    // organization has no learner role this throws before any row is
    // attempted, which is right — every row would otherwise land in `failed`
    // with a generic reason and the real cause never shown.
    const learnerRole = await this.roles.roleByKey(scope, 'learner');

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
      if (await this.repository.emailExists(email)) {
        failed.push({ row: rowNum, email, reason: 'Email already registered' });
        continue;
      }

      // A CSV reaches this loop without the `@IsIn` the admin form has, so the
      // closed lists are enforced here or not at all — and an import is
      // exactly how a location nobody can filter on got into the table the
      // first time. Known alternative spellings are accepted and rewritten;
      // anything else fails the row, with the valid values in the reason, so
      // the admin fixes the CSV rather than discovering months later that
      // these learners are missing from every location report.
      const location = normaliseLocation(row.location ?? null);
      if (location === INVALID) {
        failed.push({
          row: rowNum,
          email,
          reason: `Location must be one of: ${LOCATIONS.join(', ')}`,
        });
        continue;
      }
      const jobLevel = row.job_level ?? null;
      if (jobLevel !== null && !(JOB_LEVELS as readonly string[]).includes(jobLevel)) {
        failed.push({
          row: rowNum,
          email,
          reason: `Job level must be one of: ${JOB_LEVELS.join(', ')}`,
        });
        continue;
      }

      try {
        await this.repository.createLearner(scope, {
          employeeId: row.employee_id ?? null,
          firstName: row.first_name,
          lastName: row.last_name,
          email,
          passwordHash: hashPassword(password),
          department: row.department ?? null,
          location,
          jobRole: row.job_role ?? null,
          jobLevel,
          roleId: learnerRole.id,
          role: learnerRole.portal,
        });
        created++;
      } catch {
        failed.push({ row: rowNum, email, reason: 'Database error — could not insert' });
      }
    }

    return { created, failed, total: dto.users.length };
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
}

/** Sentinel for "present but not a value we accept". `null` means "not given". */
const INVALID = Symbol('invalid-location') as unknown as string;

/**
 * Accept a known alternative spelling, reject anything else.
 *
 * Forgiving where it safely can be (`Bengaluru` and `Bangalore` are the same
 * office) and strict where it cannot: an unrecognised value is not silently
 * nulled, because a learner with no location and a learner with a location the
 * filter cannot offer look identical afterwards and only one of them is a
 * mistake somebody can find.
 */
function normaliseLocation(value: string | null): string | null {
  if (value === null) return null;
  const canonical = LOCATION_ALIASES[value] ?? value;
  return (LOCATIONS as readonly string[]).includes(canonical)
    ? canonical
    : INVALID;
}

/** `admin` -> `Admin`. Only a fallback for a user whose role row is missing. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
