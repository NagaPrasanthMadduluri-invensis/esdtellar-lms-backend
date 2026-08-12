import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { courses } from './courses.schema';
import { users } from './users.schema';

export const assessments = sqliteTable(
  'assessments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    passingScore: integer('passing_score').notNull().default(60),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_assessments_course').on(table.courseId, table.isActive),
  ],
);

export const assessmentQuestions = sqliteTable(
  'assessment_questions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    assessmentId: integer('assessment_id')
      .notNull()
      .references(() => assessments.id, { onDelete: 'cascade' }),
    questionText: text('question_text').notNull(),
    marks: integer('marks').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [
    index('idx_questions_assessment').on(table.assessmentId, table.sortOrder),
  ],
);

export const assessmentOptions = sqliteTable(
  'assessment_options',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    questionId: integer('question_id')
      .notNull()
      .references(() => assessmentQuestions.id, { onDelete: 'cascade' }),
    optionText: text('option_text').notNull(),
    isCorrect: integer('is_correct').notNull().default(0),
  },
  (table) => [index('idx_options_question').on(table.questionId)],
);

export const userAssessmentAttempts = sqliteTable(
  'user_assessment_attempts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assessmentId: integer('assessment_id')
      .notNull()
      .references(() => assessments.id, { onDelete: 'cascade' }),
    score: integer('score').notNull().default(0),
    totalQuestions: integer('total_questions').notNull().default(0),
    percentage: integer('percentage').notNull().default(0),
    isPassed: integer('is_passed').notNull().default(0),
    submittedAt: text('submitted_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    // Best-score / has-passed lookups are per (user, assessment) and run on
    // every course-progress read — this is the hottest index in the schema.
    index('idx_attempts_user_assessment').on(table.userId, table.assessmentId),
  ],
);

export const userAssessmentAnswers = sqliteTable(
  'user_assessment_answers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    attemptId: integer('attempt_id')
      .notNull()
      .references(() => userAssessmentAttempts.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => assessmentQuestions.id),
    selectedOptionId: integer('selected_option_id').references(
      () => assessmentOptions.id,
    ),
    isCorrect: integer('is_correct').notNull().default(0),
  },
  (table) => [index('idx_answers_attempt').on(table.attemptId)],
);

export type AssessmentRow = typeof assessments.$inferSelect;
export type AssessmentQuestionRow = typeof assessmentQuestions.$inferSelect;
export type AssessmentOptionRow = typeof assessmentOptions.$inferSelect;
export type UserAssessmentAttemptRow =
  typeof userAssessmentAttempts.$inferSelect;
