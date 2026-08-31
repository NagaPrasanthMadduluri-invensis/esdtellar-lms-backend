import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import { users } from '@/database/schema';

export interface LearnerListRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  department: string | null;
  location: string | null;
  job_role: string | null;
  is_active: number;
  created_at: string;
  assigned_courses: number;
}

export interface EmployeeAggregateRow extends LearnerListRow {
  total_lessons: number;
  completed_lessons: number;
  best_score: number | null;
  has_passed: number | null;
  attempt_count: number;
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
             u.location, u.job_role, u.is_active, u.created_at,
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
             u.location, u.job_role, u.is_active, u.created_at,
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
        role: 'learner',
        department: input.department,
        location: input.location,
        jobRole: input.jobRole,
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
      location: string | null;
      jobRole: string | null;
    },
  ) {
    const [updated] = await this.db
      .update(users)
      .set({
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        location: input.location,
        jobRole: input.jobRole,
      })
      .where(
        and(eq(users.id, id), eq(users.organizationId, scope.organizationId)),
      )
      .returning({
        id: users.id,
        first_name: users.firstName,
        last_name: users.lastName,
        email: users.email,
        location: users.location,
        job_role: users.jobRole,
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
  async scormPackagesForAssignedCourses(userId: number) {
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
