import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { contentScope, orgScope, type OrgScope } from '@/database/org-scope';
import {
  assessmentOptions,
  assessmentQuestions,
  assessments,
  userAssessmentAnswers,
  userAssessmentAttempts,
  userCourseAssignments,
} from '@/database/schema';

@Injectable()
export class AssessmentsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * `scope` is first on every method here (and across the sibling modules): it
   * is required, security-relevant, reads like a context argument, and can
   * never collide with an optional or defaulted parameter that follows it.
   */

  /* ── Admin ── */

  async listAll(scope: OrgScope) {
    return this.db.all(sql`
      SELECT a.*, c.name AS course_name, COUNT(aq.id) AS question_count
      FROM assessments a
      JOIN courses c ON c.id = a.course_id
      LEFT JOIN assessment_questions aq ON aq.assessment_id = a.id
      WHERE ${contentScope('a', scope)}
      GROUP BY a.id, c.name
      ORDER BY a.created_at DESC
    `);
  }

  async listByCourse(scope: OrgScope, courseId: number) {
    return this.db.all(sql`
      SELECT a.*,
        (SELECT COUNT(*) FROM assessment_questions
         WHERE assessment_id = a.id) AS questions_count,
        (SELECT COUNT(*) FROM user_assessment_attempts
         WHERE assessment_id = a.id) AS attempts_count
      FROM assessments a
      WHERE a.course_id = ${courseId} AND ${contentScope('a', scope)}
      ORDER BY a.created_at
    `);
  }

  /** Existence + ownership check for a course id supplied by the caller. */
  async courseExists(scope: OrgScope, courseId: number): Promise<boolean> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM courses
      WHERE id = ${courseId} AND ${contentScope('courses', scope)}
    `);
    return rows.length > 0;
  }

  async findById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select()
      .from(assessments)
      .where(
        and(eq(assessments.id, id), eq(assessments.organizationId, scope.organizationId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveWithCourse(scope: OrgScope, id: number) {
    const rows = await this.db.all<
      Record<string, unknown> & { course_id: number; passing_score: number }
    >(sql`
      SELECT a.*, c.name AS course_name
      FROM assessments a
      JOIN courses c ON c.id = a.course_id
      WHERE a.id = ${id} AND a.is_active = 1 AND ${contentScope('a', scope)}
    `);
    return rows[0] ?? null;
  }

  /** Content: takes the OWNER's org — the owning course's org, `scope` here. */
  async createAssessment(input: {
    organizationId: number;
    courseId: number;
    title: string;
    description: string | null;
    passingScore: number;
  }) {
    const [created] = await this.db
      .insert(assessments)
      .values({
        organizationId: input.organizationId,
        courseId: input.courseId,
        title: input.title,
        description: input.description,
        passingScore: input.passingScore,
        // Detached on creation. An assessment is authored under a course but is
        // not delivered to anyone until an admin attaches it on the course's
        // Assessments tab — so a half-built quiz cannot reach a learner.
        isActive: 0,
      })
      .returning();
    return created;
  }

  async updateAssessment(
    scope: OrgScope,
    id: number,
    input: {
      title: string;
      description: string | null;
      passingScore: number;
      isActive: boolean;
    },
  ) {
    const [updated] = await this.db
      .update(assessments)
      .set({
        title: input.title,
        description: input.description,
        passingScore: input.passingScore,
        isActive: input.isActive ? 1 : 0,
      })
      .where(
        and(eq(assessments.id, id), eq(assessments.organizationId, scope.organizationId)),
      )
      .returning();
    return updated;
  }

  /**
   * Attaches or detaches an assessment from its course.
   *
   * `is_active` is the attachment flag. It already gates every learner-facing
   * read, the certificate completion snapshot and the reports, so attaching is
   * one column rather than a parallel concept those 22 queries would each have
   * to learn about.
   */
  async setAttached(scope: OrgScope, id: number, attached: boolean) {
    const [updated] = await this.db
      .update(assessments)
      .set({ isActive: attached ? 1 : 0 })
      .where(
        and(eq(assessments.id, id), eq(assessments.organizationId, scope.organizationId)),
      )
      .returning();
    return updated ?? null;
  }

  async deleteAssessment(scope: OrgScope, id: number): Promise<void> {
    await this.db
      .delete(assessments)
      .where(
        and(eq(assessments.id, id), eq(assessments.organizationId, scope.organizationId)),
      );
  }

  /* ── Questions & options ── */

  async listQuestions(scope: OrgScope, assessmentId: number) {
    return this.db
      .select()
      .from(assessmentQuestions)
      .where(
        and(
          eq(assessmentQuestions.assessmentId, assessmentId),
          eq(assessmentQuestions.organizationId, scope.organizationId),
        ),
      )
      .orderBy(asc(assessmentQuestions.sortOrder));
  }

  /**
   * All options for an assessment in one query. `includeAnswerKey` is false for
   * learner-facing reads — `is_correct` must never reach the browser before the
   * attempt is submitted, or the quiz answers are in the page payload.
   */
  async listOptionsForAssessment(
    scope: OrgScope,
    assessmentId: number,
    includeAnswerKey: boolean,
  ) {
    if (includeAnswerKey) {
      return this.db.all<Record<string, unknown> & { question_id: number }>(sql`
        SELECT ao.* FROM assessment_options ao
        JOIN assessment_questions aq ON aq.id = ao.question_id
        WHERE aq.assessment_id = ${assessmentId} AND ${contentScope('ao', scope)}
      `);
    }
    return this.db.all<Record<string, unknown> & { question_id: number }>(sql`
      SELECT ao.id, ao.option_text, ao.question_id FROM assessment_options ao
      JOIN assessment_questions aq ON aq.id = ao.question_id
      WHERE aq.assessment_id = ${assessmentId} AND ${contentScope('ao', scope)}
    `);
  }

  async listOptionsForQuestion(scope: OrgScope, questionId: number) {
    return this.db
      .select()
      .from(assessmentOptions)
      .where(
        and(
          eq(assessmentOptions.questionId, questionId),
          eq(assessmentOptions.organizationId, scope.organizationId),
        ),
      );
  }

  async nextQuestionSortOrder(scope: OrgScope, assessmentId: number): Promise<number> {
    const rows = await this.db.all<{ m: number | null }>(sql`
      SELECT MAX(sort_order) AS m FROM assessment_questions
      WHERE assessment_id = ${assessmentId}
        AND ${contentScope('assessment_questions', scope)}
    `);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  /** Content: takes the OWNER's org — the owning assessment's org, `scope` here. */
  async createQuestion(input: {
    organizationId: number;
    assessmentId: number;
    questionText: string;
    marks: number;
    sortOrder: number;
  }) {
    const [created] = await this.db
      .insert(assessmentQuestions)
      .values({
        organizationId: input.organizationId,
        assessmentId: input.assessmentId,
        questionText: input.questionText,
        marks: input.marks,
        sortOrder: input.sortOrder,
      })
      .returning();
    return created;
  }

  async updateQuestion(
    scope: OrgScope,
    id: number,
    input: { questionText: string; marks: number },
  ) {
    const [updated] = await this.db
      .update(assessmentQuestions)
      .set({ questionText: input.questionText, marks: input.marks })
      .where(
        and(
          eq(assessmentQuestions.id, id),
          eq(assessmentQuestions.organizationId, scope.organizationId),
        ),
      )
      .returning();
    return updated;
  }

  async deleteQuestion(scope: OrgScope, id: number): Promise<void> {
    await this.db
      .delete(assessmentQuestions)
      .where(
        and(
          eq(assessmentQuestions.id, id),
          eq(assessmentQuestions.organizationId, scope.organizationId),
        ),
      );
  }

  /**
   * Bulk insert — one statement instead of one round trip per option.
   *
   * Content: takes the OWNER's org, `scope` here — the same org as the
   * question these options belong to (already verified by the caller).
   */
  async replaceOptions(
    scope: OrgScope,
    questionId: number,
    options: { option_text: string; is_correct?: boolean }[],
  ): Promise<void> {
    await this.db
      .delete(assessmentOptions)
      .where(
        and(
          eq(assessmentOptions.questionId, questionId),
          eq(assessmentOptions.organizationId, scope.organizationId),
        ),
      );

    if (options.length === 0) return;

    await this.db.insert(assessmentOptions).values(
      options.map((option) => ({
        organizationId: scope.organizationId,
        questionId,
        optionText: option.option_text.trim(),
        isCorrect: option.is_correct ? 1 : 0,
      })),
    );
  }

  /* ── Learner ── */

  async isAssignedToCourse(scope: OrgScope, userId: number, courseId: number) {
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
    return rows.length > 0;
  }

  /**
   * Every assessment across the learner's assigned courses, with lesson-unlock
   * state and their own attempt stats. The legacy handler looped over courses
   * and then over assessments, issuing a query at each level.
   *
   * `a` is the query root; the correlated subqueries below are all anchored on
   * `a.id` / `a.course_id`, so they inherit tenancy from the outer predicate.
   */
  async listForLearner(scope: OrgScope, userId: number) {
    return this.db.all<{
      id: number;
      title: string;
      description: string | null;
      passing_score: number;
      course_id: number;
      course_name: string;
      questions_count: number;
      attempt_count: number;
      best_score: number | null;
      total_lessons: number;
      completed_lessons: number;
    }>(sql`
      SELECT a.id, a.title, a.description, a.passing_score,
             a.course_id, c.name AS course_name,
             (SELECT COUNT(*) FROM assessment_questions
              WHERE assessment_id = a.id) AS questions_count,
             (SELECT COUNT(*) FROM user_assessment_attempts
              WHERE assessment_id = a.id AND user_id = ${userId}) AS attempt_count,
             (SELECT MAX(percentage) FROM user_assessment_attempts
              WHERE assessment_id = a.id AND user_id = ${userId}) AS best_score,
             (SELECT COUNT(*) FROM lessons l
              JOIN course_modules cm ON cm.id = l.module_id
              WHERE cm.course_id = a.course_id
                AND l.is_active = 1 AND cm.is_active = 1) AS total_lessons,
             (SELECT COUNT(*) FROM user_lesson_completions ulc
              JOIN lessons l ON l.id = ulc.lesson_id
              JOIN course_modules cm ON cm.id = l.module_id
              WHERE cm.course_id = a.course_id
                AND l.is_active = 1 AND cm.is_active = 1
                AND ulc.user_id = ${userId}) AS completed_lessons
      FROM assessments a
      JOIN courses c ON c.id = a.course_id AND c.is_active = 1
      JOIN user_course_assignments uca
        ON uca.course_id = a.course_id AND uca.user_id = ${userId}
      WHERE a.is_active = 1 AND ${contentScope('a', scope)}
      ORDER BY a.created_at
    `);
  }

  /** All of a learner's attempts across their assigned courses, one query. */
  async attemptsForLearner(scope: OrgScope, userId: number) {
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
      WHERE t.user_id = ${userId} AND ${orgScope('t', scope)}
      ORDER BY t.submitted_at DESC
    `);
  }

  async attemptsFor(scope: OrgScope, userId: number, assessmentId: number) {
    return this.db
      .select()
      .from(userAssessmentAttempts)
      .where(
        and(
          eq(userAssessmentAttempts.userId, userId),
          eq(userAssessmentAttempts.assessmentId, assessmentId),
          eq(userAssessmentAttempts.organizationId, scope.organizationId),
        ),
      )
      .orderBy(desc(userAssessmentAttempts.submittedAt));
  }

  async countAttempts(
    scope: OrgScope,
    userId: number,
    assessmentId: number,
  ): Promise<number> {
    const rows = await this.db.all<{ c: number }>(sql`
      SELECT COUNT(*) AS c FROM user_assessment_attempts
      WHERE assessment_id = ${assessmentId} AND user_id = ${userId}
        AND ${orgScope('user_assessment_attempts', scope)}
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /** The answer key: one row per question with its correct option. */
  /**
   * The scored answer key. `option_ids` is carried so the service can discard
   * a submitted option that does not belong to its question: both ids arrive
   * in the request body and are single-column FKs, so the database would
   * otherwise accept another organization's (§3.5).
   */
  async answerKey(scope: OrgScope, assessmentId: number) {
    return this.db.all<{
      id: number;
      question_text: string;
      correct_option_id: number;
      option_ids: number[];
    }>(sql`
      SELECT aq.id, aq.question_text,
             MAX(ao.id) FILTER (WHERE ao.is_correct = 1) AS correct_option_id,
             array_agg(ao.id) AS option_ids
      FROM assessment_questions aq
      JOIN assessment_options ao ON ao.question_id = aq.id
      WHERE aq.assessment_id = ${assessmentId} AND ${contentScope('aq', scope)}
      GROUP BY aq.id, aq.question_text
    `);
  }

  /**
   * Records an attempt and its per-question answers.
   *
   * Both tables are activity: `scope` is the submitting learner's own org.
   * `user_assessment_answers` carries no `user_id` of its own — its org comes
   * through the attempt it belongs to, which is exactly this `scope` (§3.3).
   */
  async recordAttempt(
    scope: OrgScope,
    input: {
      userId: number;
      assessmentId: number;
      score: number;
      totalQuestions: number;
      percentage: number;
      isPassed: number;
      answers: {
        question_id: number;
        selected_option_id: number | null;
        is_correct: number;
      }[];
    },
  ): Promise<number> {
    const [attempt] = await this.db
      .insert(userAssessmentAttempts)
      .values({
        organizationId: scope.organizationId,
        userId: input.userId,
        assessmentId: input.assessmentId,
        score: input.score,
        totalQuestions: input.totalQuestions,
        percentage: input.percentage,
        isPassed: input.isPassed,
      })
      .returning({ id: userAssessmentAttempts.id });

    if (input.answers.length > 0) {
      // Bulk insert — the legacy code inserted one answer per round trip.
      await this.db.insert(userAssessmentAnswers).values(
        input.answers.map((answer) => ({
          organizationId: scope.organizationId,
          attemptId: attempt.id,
          questionId: answer.question_id,
          selectedOptionId: answer.selected_option_id,
          isCorrect: answer.is_correct,
        })),
      );
    }

    return attempt.id;
  }
}
