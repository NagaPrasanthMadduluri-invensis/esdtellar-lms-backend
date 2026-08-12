import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
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

  /* ── Admin ── */

  async listAll() {
    return this.db.all(sql`
      SELECT a.*, c.name AS course_name, COUNT(aq.id) AS question_count
      FROM assessments a
      JOIN courses c ON c.id = a.course_id
      LEFT JOIN assessment_questions aq ON aq.assessment_id = a.id
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `);
  }

  async listByCourse(courseId: number) {
    return this.db.all(sql`
      SELECT a.*,
        (SELECT COUNT(*) FROM assessment_questions
         WHERE assessment_id = a.id) AS questions_count,
        (SELECT COUNT(*) FROM user_assessment_attempts
         WHERE assessment_id = a.id) AS attempts_count
      FROM assessments a
      WHERE a.course_id = ${courseId}
      ORDER BY a.created_at
    `);
  }

  async findById(id: number) {
    const rows = await this.db
      .select()
      .from(assessments)
      .where(eq(assessments.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findActiveWithCourse(id: number) {
    const rows = await this.db.all<Record<string, unknown> & { course_id: number; passing_score: number }>(sql`
      SELECT a.*, c.name AS course_name
      FROM assessments a
      JOIN courses c ON c.id = a.course_id
      WHERE a.id = ${id} AND a.is_active = 1
    `);
    return rows[0] ?? null;
  }

  async createAssessment(input: {
    courseId: number;
    title: string;
    description: string | null;
    passingScore: number;
  }) {
    const [created] = await this.db
      .insert(assessments)
      .values({
        courseId: input.courseId,
        title: input.title,
        description: input.description,
        passingScore: input.passingScore,
      })
      .returning();
    return created;
  }

  async updateAssessment(
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
      .where(eq(assessments.id, id))
      .returning();
    return updated;
  }

  async deleteAssessment(id: number): Promise<void> {
    await this.db.delete(assessments).where(eq(assessments.id, id));
  }

  /* ── Questions & options ── */

  async listQuestions(assessmentId: number) {
    return this.db
      .select()
      .from(assessmentQuestions)
      .where(eq(assessmentQuestions.assessmentId, assessmentId))
      .orderBy(asc(assessmentQuestions.sortOrder));
  }

  /**
   * All options for an assessment in one query. `includeAnswerKey` is false for
   * learner-facing reads — `is_correct` must never reach the browser before the
   * attempt is submitted, or the quiz answers are in the page payload.
   */
  async listOptionsForAssessment(assessmentId: number, includeAnswerKey: boolean) {
    if (includeAnswerKey) {
      return this.db.all<Record<string, unknown> & { question_id: number }>(sql`
        SELECT ao.* FROM assessment_options ao
        JOIN assessment_questions aq ON aq.id = ao.question_id
        WHERE aq.assessment_id = ${assessmentId}
      `);
    }
    return this.db.all<Record<string, unknown> & { question_id: number }>(sql`
      SELECT ao.id, ao.option_text, ao.question_id FROM assessment_options ao
      JOIN assessment_questions aq ON aq.id = ao.question_id
      WHERE aq.assessment_id = ${assessmentId}
    `);
  }

  async listOptionsForQuestion(questionId: number) {
    return this.db
      .select()
      .from(assessmentOptions)
      .where(eq(assessmentOptions.questionId, questionId));
  }

  async nextQuestionSortOrder(assessmentId: number): Promise<number> {
    const rows = await this.db.all<{ m: number | null }>(sql`
      SELECT MAX(sort_order) AS m FROM assessment_questions
      WHERE assessment_id = ${assessmentId}
    `);
    return Number(rows[0]?.m ?? 0) + 1;
  }

  async createQuestion(input: {
    assessmentId: number;
    questionText: string;
    marks: number;
    sortOrder: number;
  }) {
    const [created] = await this.db
      .insert(assessmentQuestions)
      .values({
        assessmentId: input.assessmentId,
        questionText: input.questionText,
        marks: input.marks,
        sortOrder: input.sortOrder,
      })
      .returning();
    return created;
  }

  async updateQuestion(
    id: number,
    input: { questionText: string; marks: number },
  ) {
    const [updated] = await this.db
      .update(assessmentQuestions)
      .set({ questionText: input.questionText, marks: input.marks })
      .where(eq(assessmentQuestions.id, id))
      .returning();
    return updated;
  }

  async deleteQuestion(id: number): Promise<void> {
    await this.db.delete(assessmentQuestions).where(eq(assessmentQuestions.id, id));
  }

  /** Bulk insert — one statement instead of one round trip per option. */
  async replaceOptions(
    questionId: number,
    options: { option_text: string; is_correct?: boolean }[],
  ): Promise<void> {
    await this.db
      .delete(assessmentOptions)
      .where(eq(assessmentOptions.questionId, questionId));

    if (options.length === 0) return;

    await this.db.insert(assessmentOptions).values(
      options.map((option) => ({
        questionId,
        optionText: option.option_text.trim(),
        isCorrect: option.is_correct ? 1 : 0,
      })),
    );
  }

  /* ── Learner ── */

  async isAssignedToCourse(userId: number, courseId: number) {
    const rows = await this.db
      .select({ id: userCourseAssignments.id })
      .from(userCourseAssignments)
      .where(
        and(
          eq(userCourseAssignments.userId, userId),
          eq(userCourseAssignments.courseId, courseId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Every assessment across the learner's assigned courses, with lesson-unlock
   * state and their own attempt stats. The legacy handler looped over courses
   * and then over assessments, issuing a query at each level.
   */
  async listForLearner(userId: number) {
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
      WHERE a.is_active = 1
      ORDER BY a.created_at
    `);
  }

  /** All of a learner's attempts across their assigned courses, one query. */
  async attemptsForLearner(userId: number) {
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
      WHERE t.user_id = ${userId}
      ORDER BY t.submitted_at DESC
    `);
  }

  async attemptsFor(userId: number, assessmentId: number) {
    return this.db
      .select()
      .from(userAssessmentAttempts)
      .where(
        and(
          eq(userAssessmentAttempts.userId, userId),
          eq(userAssessmentAttempts.assessmentId, assessmentId),
        ),
      )
      .orderBy(desc(userAssessmentAttempts.submittedAt));
  }

  async countAttempts(userId: number, assessmentId: number): Promise<number> {
    const rows = await this.db.all<{ c: number }>(sql`
      SELECT COUNT(*) AS c FROM user_assessment_attempts
      WHERE assessment_id = ${assessmentId} AND user_id = ${userId}
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /** The answer key: one row per question with its correct option. */
  async answerKey(assessmentId: number) {
    return this.db.all<{
      id: number;
      question_text: string;
      correct_option_id: number;
    }>(sql`
      SELECT aq.id, aq.question_text, ao.id AS correct_option_id
      FROM assessment_questions aq
      JOIN assessment_options ao
        ON ao.question_id = aq.id AND ao.is_correct = 1
      WHERE aq.assessment_id = ${assessmentId}
    `);
  }

  async recordAttempt(input: {
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
  }): Promise<number> {
    const [attempt] = await this.db
      .insert(userAssessmentAttempts)
      .values({
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
