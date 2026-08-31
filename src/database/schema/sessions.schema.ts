import { index, integer, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { courses } from './courses.schema';
import { users } from './users.schema';

/** Instructor-led (ILT) or Virtual training events. */
export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    /** Always a real org — never the platform org (§3.3, §3.4). */
    organizationId: integer('organization_id').notNull(),
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
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Calendar views scan by date; the sessions list filters by status.
    index('idx_sessions_date').on(table.date),
    index('idx_sessions_status').on(table.status),
    index('idx_sessions_org_date').on(table.organizationId, table.date),
  ],
);

export const sessionRoster = pgTable(
  'session_roster',
  {
    id: serial('id').primaryKey(),
    /** Activity: the enrolled user's org. */
    organizationId: integer('organization_id').notNull(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    enrolledAt: timestamp('enrolled_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_session_roster_org_session').on(table.organizationId, table.sessionId),
    unique('session_roster_session_user_unique').on(
      table.sessionId,
      table.userId,
    ),
    index('idx_roster_user').on(table.userId),
  ],
);

/** `isLocked = 1` finalises the record — the UI refuses further edits. */
export const sessionAttendance = pgTable(
  'session_attendance',
  {
    id: serial('id').primaryKey(),
    /** Activity: the attending user's org. */
    organizationId: integer('organization_id').notNull(),
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
    markedAt: timestamp('marked_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_session_attendance_org_session').on(table.organizationId, table.sessionId),
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
