import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

import { courses, lessons } from './courses.schema';
import { users } from './users.schema';

/** Admin -> learner course assignment. One row per learner per course. */
export const userCourseAssignments = sqliteTable(
  'user_course_assignments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    assignedBy: integer('assigned_by').references(() => users.id),
    assignedAt: text('assigned_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    dueDate: text('due_date'),
  },
  (table) => [
    unique('user_course_assignments_user_course_unique').on(
      table.userId,
      table.courseId,
    ),
    // The UNIQUE above already serves (user_id) lookups; admin-side "who is
    // enrolled in this course" needs the reverse direction.
    index('idx_assignments_course').on(table.courseId),
  ],
);

/** Idempotent lesson completion. Progress % is derived from this table. */
export const userLessonCompletions = sqliteTable(
  'user_lesson_completions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    completedAt: text('completed_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique('user_lesson_completions_user_lesson_unique').on(
      table.userId,
      table.lessonId,
    ),
    // Progress joins go lessons -> completions, so lesson_id needs its own index.
    index('idx_completions_lesson').on(table.lessonId),
  ],
);

export type UserCourseAssignmentRow = typeof userCourseAssignments.$inferSelect;
export type UserLessonCompletionRow = typeof userLessonCompletions.$inferSelect;
