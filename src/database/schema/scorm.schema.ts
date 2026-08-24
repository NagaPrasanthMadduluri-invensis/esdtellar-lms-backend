import { index, integer, pgTable, real, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { users } from './users.schema';

/**
 * `packageDir` is the UUID directory name under the SCORM storage root. The
 * storage root itself is owned by the StorageService, so swapping local disk
 * for S3/R2 later never touches this table.
 */
export const scormPackages = pgTable(
  'scorm_packages',
  {
    id: serial('id').primaryKey(),
    title: text('title').notNull(),
    version: text('version', { enum: ['1.2', '2004'] })
      .notNull()
      .default('1.2'),
    entryPoint: text('entry_point').notNull(),
    packageDir: text('package_dir').notNull().unique(),
    /**
     * FK to courses(id) ON DELETE SET NULL in the live database. It is declared
     * here without `.references()` on purpose: `courses.lessons` already points
     * at `scormPackages`, and closing the loop would make courses.schema and
     * scorm.schema import each other. The constraint exists in the database;
     * only the Drizzle metadata omits it.
     */
    courseId: integer('course_id'),
    /**
     * Runtime declared by the manifest's LOM `typicalLearningTime`, in minutes.
     * Null when the package does not say — plenty of authoring tools omit it —
     * and then the lesson's duration has to be typed by the admin instead.
     * This is the package's STATED length; actual learning hours still come
     * from the runtime's own reported `total_time` (§10.4).
     */
    durationMinutes: integer('duration_minutes'),
    createdBy: integer('created_by').references(() => users.id),
    isActive: integer('is_active').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_scorm_packages_active').on(table.isActive)],
);

export const userScormAssignments = pgTable(
  'user_scorm_assignments',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: integer('package_id')
      .notNull()
      .references(() => scormPackages.id, { onDelete: 'cascade' }),
    assignedBy: integer('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('user_scorm_assignments_user_package_unique').on(
      table.userId,
      table.packageId,
    ),
    index('idx_scorm_assignments_package').on(table.packageId),
  ],
);

/** One row per (user, package). `cmiData` holds the full CMI object as JSON. */
export const scormTracking = pgTable(
  'scorm_tracking',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: integer('package_id')
      .notNull()
      .references(() => scormPackages.id, { onDelete: 'cascade' }),
    /** SCORM 1.2 */
    lessonStatus: text('lesson_status').default('not attempted'),
    /** SCORM 2004 */
    completionStatus: text('completion_status').default('unknown'),
    successStatus: text('success_status').default('unknown'),
    scoreRaw: real('score_raw'),
    scoreMin: real('score_min'),
    scoreMax: real('score_max'),
    totalTime: text('total_time'),
    suspendData: text('suspend_data'),
    location: text('location'),
    cmiData: text('cmi_data').notNull().default('{}'),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('scorm_tracking_user_package_unique').on(
      table.userId,
      table.packageId,
    ),
    index('idx_scorm_tracking_package').on(table.packageId),
  ],
);

/**
 * Append-only attempt history — the counterpart to `scormTracking`, which is
 * upserted and therefore only ever describes the latest state.
 *
 * Deliberately shaped like `userAssessmentAttempts` so an admin screen can
 * render a SCORM package's attempts with the same columns it uses for an
 * assessment: which attempt, what score, when submitted, passed or failed.
 */
export const scormAttempts = pgTable(
  'scorm_attempts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: integer('package_id')
      .notNull()
      .references(() => scormPackages.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    scoreRaw: real('score_raw'),
    scoreMax: real('score_max'),
    /** Rounded 0-100. Null when the package reports no score. */
    percentage: integer('percentage'),
    lessonStatus: text('lesson_status'),
    completionStatus: text('completion_status'),
    successStatus: text('success_status'),
    /** Null when the package only tracks completion and never grades. */
    isPassed: integer('is_passed'),
    totalTime: text('total_time'),
    /** CMI snapshot at submission — holds `interactions` when reported. */
    cmiData: text('cmi_data').notNull().default('{}'),
    submittedAt: timestamp('submitted_at', {
      mode: 'string',
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_scorm_attempts_user_package').on(table.userId, table.packageId),
    index('idx_scorm_attempts_package').on(table.packageId),
  ],
);

export type ScormPackageRow = typeof scormPackages.$inferSelect;
export type ScormTrackingRow = typeof scormTracking.$inferSelect;
export type ScormAttemptRow = typeof scormAttempts.$inferSelect;
