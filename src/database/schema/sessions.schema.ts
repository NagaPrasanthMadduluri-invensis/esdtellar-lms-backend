import { index, integer, pgTable, serial, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';

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
    /**
     * The trainer's own `users` row, when the session has been assigned to one
     * (`specs/rbac.md` §3.6.1). Nullable: a session may name a trainer only as
     * free text — an external facilitator, or one scheduled before trainer
     * accounts existed — and that session simply appears in no trainer's
     * portal. `trainer` above stays the display name and is DERIVED from this
     * user when it is set, so the two cannot disagree.
     *
     * Bound to the same org by `sessions_trainer_same_org`, added in
     * `scripts/migrate-rbac.mjs`: a session pointing at a user in another
     * organization is rejected by Postgres.
     */
    trainerUserId: integer('trainer_user_id'),
    /** ILT: room/venue name. Virtual: meeting URL. */
    venueUrl: text('venue_url').notNull(),
    date: text('date').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    description: text('description'),
    status: text('status', { enum: ['upcoming', 'completed', 'cancelled'] })
      .notNull()
      .default('upcoming'),
    /**
     * `assigned` (an admin adds people) or `self` (learners enrol themselves,
     * then queue on the waitlist). One of `ENROLL_MODES` in
     * `common/session-enrolment.ts`. Defaults to `assigned`, which is what
     * every session did before `0025_session_batches.sql`.
     */
    enrollMode: text('enroll_mode').notNull().default('assigned'),
    /**
     * Archive — orthogonal to `status`, added by `0024_session_archive.sql`.
     * NULL means live. Archiving clears a finished session off the working
     * list; it touches neither the roster, the attendance record nor the
     * companion training course, which is what makes it the safe alternative
     * to deleting one (§10.7 — a delete cascades into learning history).
     */
    archivedAt: timestamp('archived_at', { mode: 'string', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Calendar views scan by date; the sessions list filters by status.
    index('idx_sessions_date').on(table.date),
    index('idx_sessions_status').on(table.status),
    index('idx_sessions_org_date').on(table.organizationId, table.date),
    index('idx_sessions_org_archived').on(
      table.organizationId,
      table.archivedAt,
      table.date.desc(),
    ),
    index('idx_sessions_trainer_user').on(table.organizationId, table.trainerUserId),
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
    /**
     * Which sitting this learner is in. NULL = the session's own sitting,
     * which is every row that predates `0025_session_batches.sql`.
     *
     * ON DELETE SET NULL in SQL: deleting a batch must not unenrol the people
     * in it — they fall back to the session's own sitting and the admin
     * re-assigns them. Same choice 0020 made for lessons losing their module.
     */
    batchId: integer('batch_id'),
    enrolledAt: timestamp('enrolled_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_session_roster_batch').on(table.batchId),
    index('idx_session_roster_org_session').on(table.organizationId, table.sessionId),
    unique('session_roster_session_user_unique').on(
      table.sessionId,
      table.userId,
    ),
    index('idx_roster_user').on(table.userId),
  ],
);

/** `isLocked = 1` finalises the record — the UI refuses further edits. */
/**
 * A scheduling subdivision of ONE session's roster — never a separate course.
 *
 * Read the header of `0025_session_batches.sql` before changing anything here:
 * the session still owns exactly one companion training course (§10.7), and a
 * learner attends exactly one batch of it. Making a batch its own course would
 * break what "completed" means and hand two learners on the same session
 * different certificates.
 *
 * Batches are OPTIONAL. A session with no rows here is a single sitting using
 * the session's own date, time and capacity — which is every session that
 * predates this table, and why no backfill was needed.
 */
export const sessionBatches = pgTable(
  'session_batches',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    sessionId: integer('session_id').notNull(),
    /** Stored, not derived from row order — deleting batch 2 must not
     *  renumber batch 3 under people already told which batch they are in. */
    batchNo: integer('batch_no').notNull(),
    label: text('label'),
    /** NULL means the date is not fixed yet — the derived `pending` state. */
    date: text('date'),
    startTime: text('start_time'),
    endTime: text('end_time'),
    /** NULL falls back to the session's own capacity. */
    capacity: integer('capacity'),
    trainerUserId: integer('trainer_user_id'),
    /** One of `BATCH_STATUSES`. `pending` is derived, never stored. */
    status: text('status').notNull().default('scheduled'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_session_batches_session').on(table.sessionId, table.batchNo),
    index('idx_session_batches_org').on(table.organizationId, table.sessionId),
    uniqueIndex('idx_session_batches_session_no').on(table.sessionId, table.batchNo),
  ],
);

export type SessionBatchRow = typeof sessionBatches.$inferSelect;

/**
 * People queuing for a full SELF-ENROL session.
 *
 * Deliberately its own table, not a status on `session_roster`: a waitlisted
 * person is not enrolled. They hold no course assignment, the training is not
 * in their My Courses, and they must not be counted in the roster or credited
 * by attendance. A flag on the roster would mean every one of those queries
 * needing a new predicate, and the first to forget would enrol somebody who is
 * still queuing.
 */
export const sessionWaitlist = pgTable(
  'session_waitlist',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    sessionId: integer('session_id').notNull(),
    userId: integer('user_id').notNull(),
    /** Position is by arrival, so the queue needs no rank column. */
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_session_waitlist_unique').on(table.sessionId, table.userId),
    index('idx_session_waitlist_session').on(table.sessionId, table.createdAt),
    index('idx_session_waitlist_org').on(table.organizationId, table.sessionId),
  ],
);

export type SessionWaitlistRow = typeof sessionWaitlist.$inferSelect;

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
