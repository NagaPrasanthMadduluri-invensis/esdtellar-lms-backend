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

/**
 * Measured watch time for an uploaded video lesson.
 *
 * The counterpart to `scormTracking` for video: SCORM reports its own time, and
 * this is how video reports its own. `watchedSeconds` is the furthest position
 * reached rather than a sum of playing time, so a replay cannot inflate it and
 * the seek guard in the player makes skipping unable to.
 */
export const lessonVideoProgress = pgTable(
  'lesson_video_progress',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    /** Monotonic — only ever raised. */
    watchedSeconds: integer('watched_seconds').notNull().default(0),
    /** Resume point. Free to move backwards. */
    lastPositionSeconds: integer('last_position_seconds').notNull().default(0),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('lesson_video_progress_user_lesson_unique').on(
      table.userId,
      table.lessonId,
    ),
    index('idx_video_progress_lesson').on(table.lessonId),
  ],
);

export type LessonVideoProgressRow = typeof lessonVideoProgress.$inferSelect;
