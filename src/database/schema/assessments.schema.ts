import { boolean, index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

import { courses } from './courses.schema';
import { users } from './users.schema';

export const assessments = pgTable(
  'assessments',
  {
    id: serial('id').primaryKey(),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    passingScore: integer('passing_score').notNull().default(60),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_assessments_course').on(table.courseId, table.isActive),
  ],
);

export const assessmentQuestions = pgTable(
  'assessment_questions',
  {
    id: serial('id').primaryKey(),
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

export const assessmentOptions = pgTable(
  'assessment_options',
  {
    id: serial('id').primaryKey(),
    questionId: integer('question_id')
      .notNull()
      .references(() => assessmentQuestions.id, { onDelete: 'cascade' }),
    optionText: text('option_text').notNull(),
    isCorrect: boolean('is_correct').notNull().default(false),
  },
  (table) => [index('idx_options_question').on(table.questionId)],
);

export const userAssessmentAttempts = pgTable(
  'user_assessment_attempts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assessmentId: integer('assessment_id')
      .notNull()
      .references(() => assessments.id, { onDelete: 'cascade' }),
    score: integer('score').notNull().default(0),
    totalQuestions: integer('total_questions').notNull().default(0),
    percentage: integer('percentage').notNull().default(0),
    isPassed: boolean('is_passed').notNull().default(false),
    submittedAt: timestamp('submitted_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Best-score / has-passed lookups are per (user, assessment) and run on
    // every course-progress read — this is the hottest index in the schema.
    index('idx_attempts_user_assessment').on(table.userId, table.assessmentId),
  ],
);

export const userAssessmentAnswers = pgTable(
  'user_assessment_answers',
  {
    id: serial('id').primaryKey(),
    attemptId: integer('attempt_id')
      .notNull()
      .references(() => userAssessmentAttempts.id, { onDelete: 'cascade' }),
    questionId: integer('question_id')
      .notNull()
      .references(() => assessmentQuestions.id),
    selectedOptionId: integer('selected_option_id').references(
      () => assessmentOptions.id,
    ),
    isCorrect: boolean('is_correct').notNull().default(false),
  },
  (table) => [index('idx_answers_attempt').on(table.attemptId)],
);

export type AssessmentRow = typeof assessments.$inferSelect;
export type AssessmentQuestionRow = typeof assessmentQuestions.$inferSelect;
export type AssessmentOptionRow = typeof assessmentOptions.$inferSelect;
export type UserAssessmentAttemptRow =
  typeof userAssessmentAttempts.$inferSelect;
