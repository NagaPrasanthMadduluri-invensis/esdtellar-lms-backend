import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

import { courses } from './courses.schema';
import { users } from './users.schema';

/** Instructor-led (ILT) or Virtual training events. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    sessionType: text('session_type', { enum: ['ILT', 'Virtual'] })
      .notNull()
      .default('ILT'),
    department: text('department'),
    courseId: integer('course_id').references(() => courses.id, {
      onDelete: 'set null',
    }),
    capacity: integer('capacity').notNull().default(20),
    trainer: text('trainer').notNull(),
    /** ILT: room/venue name. Virtual: meeting URL. */
    venueUrl: text('venue_url').notNull(),
    date: text('date').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    description: text('description'),
    status: text('status', { enum: ['upcoming', 'completed', 'cancelled'] })
      .notNull()
      .default('upcoming'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    // Calendar views scan by date; the sessions list filters by status.
    index('idx_sessions_date').on(table.date),
    index('idx_sessions_status').on(table.status),
  ],
);

export const sessionRoster = sqliteTable(
  'session_roster',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    enrolledAt: text('enrolled_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique('session_roster_session_user_unique').on(
      table.sessionId,
      table.userId,
    ),
    // The learner calendar looks up "my sessions" by user_id, which the
    // (session_id, user_id) UNIQUE cannot serve.
    index('idx_roster_user').on(table.userId),
  ],
);

/** `isLocked = 1` finalises the record — the UI refuses further edits. */
export const sessionAttendance = sqliteTable(
  'session_attendance',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['present', 'absent', 'late', 'partial', 'excused'],
    }),
    joinTime: text('join_time'),
    notes: text('notes'),
    markedBy: integer('marked_by').references(() => users.id),
    isLocked: integer('is_locked').notNull().default(0),
    markedAt: text('marked_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique('session_attendance_session_user_unique').on(
      table.sessionId,
      table.userId,
    ),
    index('idx_attendance_user').on(table.userId),
  ],
);

export type SessionRow = typeof sessions.$inferSelect;
export type SessionRosterRow = typeof sessionRoster.$inferSelect;
export type SessionAttendanceRow = typeof sessionAttendance.$inferSelect;
