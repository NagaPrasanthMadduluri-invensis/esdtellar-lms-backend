import { index, integer, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { courses, lessons } from './courses.schema';
import { users } from './users.schema';

/** Admin -> learner course assignment. One row per learner per course. */
export const userCourseAssignments = pgTable(
  'user_course_assignments',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    assignedBy: integer('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    dueDate: text('due_date'),
  },
  (table) => [
    unique('user_course_assignments_user_course_unique').on(
      table.userId,
      table.courseId,
    ),
    index('idx_assignments_course').on(table.courseId),
  ],
);

/** Idempotent lesson completion. Progress % is derived from this table. */
export const userLessonCompletions = pgTable(
  'user_lesson_completions',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    completedAt: timestamp('completed_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('user_lesson_completions_user_lesson_unique').on(
      table.userId,
      table.lessonId,
    ),
    index('idx_completions_lesson').on(table.lessonId),
  ],
);

export type UserCourseAssignmentRow = typeof userCourseAssignments.$inferSelect;
export type UserLessonCompletionRow = typeof userLessonCompletions.$inferSelect;
