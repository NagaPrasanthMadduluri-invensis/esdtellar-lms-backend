import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { hashPassword } from '@/common/crypto/password.util';

import type {
  BulkCreateUsersDto,
  CreateUserDto,
  UpdateUserDto,
} from './dto/user.dto';
import { UsersRepository } from './users.repository';

/** Applied to bulk-imported learners who arrive without a password column. */
const DEFAULT_BULK_PASSWORD = 'Edstellar@123';

@Injectable()
export class UsersService {
  constructor(private readonly repository: UsersRepository) {}

  async listLearners() {
    return { users: await this.repository.listLearners() };
  }

  async listEmployees() {
    const rows = await this.repository.listEmployeesWithProgress();

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

  async create(dto: CreateUserDto) {
    if (await this.repository.emailExists(dto.email)) {
      throw new ConflictException('Email already in use');
    }

    const user = await this.repository.createLearner({
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      passwordHash: hashPassword(dto.password),
      department: dto.department ?? null,
      location: dto.location ?? null,
      jobRole: dto.job_role ?? null,
    });

    return { user };
  }

  async update(userId: number, dto: UpdateUserDto) {
    await this.assertMutableLearner(userId);

    if (await this.repository.emailExists(dto.email, userId)) {
      throw new ConflictException('Email is already in use by another account');
    }

    const updated = await this.repository.updateProfile(userId, {
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      location: dto.location ?? null,
      jobRole: dto.job_role ?? null,
    });

    return { user: { ...updated, is_active: updated.is_active === 1 } };
  }

  async setActive(userId: number, isActive: boolean) {
    await this.assertMutableLearner(userId);
    const updated = await this.repository.setActive(userId, isActive);
    return { user: { ...updated, is_active: updated.is_active === 1 } };
  }

  async remove(userId: number) {
    await this.assertMutableLearner(userId, 'Cannot delete admin accounts');
    await this.repository.remove(userId);
    return { message: 'User deleted' };
  }

  /**
   * Full learner report: assigned courses, per-course progress, assessments
   * and every attempt. Assembled from four set-based queries.
   */
  async getLearnerDetail(userId: number) {
    const user = await this.repository.findLearnerProfile(userId);
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
      this.repository.scormPackagesForAssignedCourses(userId),
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
  async bulkCreate(dto: BulkCreateUsersDto) {
    let created = 0;
    const failed: { row: number; email: string; reason: string }[] = [];

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

      try {
        await this.repository.createLearner({
          employeeId: row.employee_id ?? null,
          firstName: row.first_name,
          lastName: row.last_name,
          email,
          passwordHash: hashPassword(password),
          department: row.department ?? null,
          location: row.location ?? null,
          jobRole: row.job_role ?? null,
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
    userId: number,
    message = 'Cannot modify admin accounts',
  ): Promise<void> {
    const user = await this.repository.findRoleById(userId);
    if (!user) throw new NotFoundException('User not found');
    if (user.role === 'admin') throw new ForbiddenException(message);
  }
}
