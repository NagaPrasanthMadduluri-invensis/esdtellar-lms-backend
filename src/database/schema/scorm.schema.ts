import {
  bigserial,
  index,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from 'drizzle-orm/pg-core';

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
    /** The owner: a real org, or the platform org for a global package (§3.4). */
    organizationId: integer('organization_id').notNull(),
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
     * Where this package's files live. Null means local disk under
     * `<SCORM_STORAGE_PATH>/<package_dir>` — every row written before object
     * storage — and a value means an object-storage key prefix, currently
     * `tenants/<organizationId>/scorm/<packageDir>/`.
     *
     * Stored rather than derived: a platform-owned package is readable by
     * every tenant (`contentScope`), so computing the prefix from the
     * REQUESTING org would address the wrong keys for exactly those rows.
     * Nullable is what lets `local` and `s3` coexist per package instead of
     * forcing a flag day.
     */
    storagePrefix: text('storage_prefix'),
    /**
     * Runtime declared by the manifest's LOM `typicalLearningTime`, in minutes.
     * Null when the package does not say — plenty of authoring tools omit it —
     * and then the lesson's duration has to be typed by the admin instead.
     * This is the package's STATED length; actual learning hours still come
     * from the runtime's own reported `total_time` (§10.4).
     */
    durationMinutes: integer('duration_minutes'),
    /**
     * When something first referenced this package — a lesson that saved, or
     * a direct library upload. NULL means provisional: the lesson editor
     * uploaded it and no lesson has claimed it yet, so it is hidden from the
     * library list and swept once old enough (migration 0010).
     */
    claimedAt: timestamp('claimed_at', { mode: 'string', withTimezone: true }),
    createdBy: integer('created_by').references(() => users.id),
    isActive: integer('is_active').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_scorm_packages_org_active').on(table.organizationId, table.isActive),
    index('idx_scorm_packages_active').on(table.isActive),
    index('idx_scorm_packages_unclaimed').on(table.createdAt),
  ],
);

export const userScormAssignments = pgTable(
  'user_scorm_assignments',
  {
    id: serial('id').primaryKey(),
    /** Activity: the assigned user's org. */
    organizationId: integer('organization_id').notNull(),
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
    index('idx_scorm_assignments_org_user').on(table.organizationId, table.userId),
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
    /** Activity: the tracked user's org. */
    organizationId: integer('organization_id').notNull(),
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
    index('idx_scorm_tracking_org_user').on(table.organizationId, table.userId),
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
    /** Activity: the attempting user's org. */
    organizationId: integer('organization_id').notNull(),
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
    index('idx_scorm_attempts_org_user').on(table.organizationId, table.userId),
    index('idx_scorm_attempts_user_package').on(table.userId, table.packageId),
    index('idx_scorm_attempts_package').on(table.packageId),
  ],
);


/**
 * Append-only log of every SCORM data-model write.
 *
 * The finest of three deliberately different grains — see the header of
 * `0009_scorm_cloud_storage_and_datamodel_log.sql`. `scormTracking` is current
 * state, `scormAttempts` is per-attempt history with a CMI snapshot, and this
 * is the individual `SetValue` deltas in the order they happened.
 *
 * Activity, never content: a learner's runtime writes always belong to their
 * own organization, so every read uses `orgScope`, never `contentScope`.
 */
export const scormDatamodelLog = pgTable(
  'scorm_datamodel_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Activity: the learner's own org. Mandatory tenant separation. */
    organizationId: integer('organization_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: integer('package_id')
      .notNull()
      .references(() => scormPackages.id, { onDelete: 'cascade' }),
    /** Matches `scormAttempts.attemptNumber`, so re-takes stay separable. */
    attemptNumber: integer('attempt_number').notNull().default(1),
    /** e.g. `cmi.core.lesson_location`, `cmi.interactions.0.result`. */
    elementKey: varchar('element_key', { length: 255 }).notNull(),
    /** Nullable — clearing an element is a legitimate write. */
    elementValue: text('element_value'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_scorm_datamodel_log_org_user').on(
      table.organizationId,
      table.userId,
    ),
    index('idx_scorm_datamodel_log_user_package_time').on(
      table.organizationId,
      table.userId,
      table.packageId,
      table.createdAt,
    ),
    index('idx_scorm_datamodel_log_package_element').on(
      table.organizationId,
      table.packageId,
      table.elementKey,
    ),
  ],
);

export type ScormPackageRow = typeof scormPackages.$inferSelect;
export type ScormTrackingRow = typeof scormTracking.$inferSelect;
export type ScormAttemptRow = typeof scormAttempts.$inferSelect;
export type ScormDatamodelLogRow = typeof scormDatamodelLog.$inferSelect;
