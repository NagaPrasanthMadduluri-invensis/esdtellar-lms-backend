import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

import { users } from './users.schema';

/**
 * `packageDir` is the UUID directory name under the SCORM storage root. The
 * storage root itself is owned by the StorageService, so swapping local disk
 * for S3/R2 later never touches this table.
 */
export const scormPackages = sqliteTable(
  'scorm_packages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
     * scorm.schema import each other. The constraint exists in Turso; only the
     * Drizzle metadata omits it.
     */
    courseId: integer('course_id'),
    createdBy: integer('created_by').references(() => users.id),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_scorm_packages_active').on(table.isActive)],
);

export const userScormAssignments = sqliteTable(
  'user_scorm_assignments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packageId: integer('package_id')
      .notNull()
      .references(() => scormPackages.id, { onDelete: 'cascade' }),
    assignedBy: integer('assigned_by').references(() => users.id),
    assignedAt: text('assigned_at')
      .notNull()
      .default(sql`(datetime('now'))`),
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
export const scormTracking = sqliteTable(
  'scorm_tracking',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique('scorm_tracking_user_package_unique').on(
      table.userId,
      table.packageId,
    ),
    index('idx_scorm_tracking_package').on(table.packageId),
  ],
);

export type ScormPackageRow = typeof scormPackages.$inferSelect;
export type ScormTrackingRow = typeof scormTracking.$inferSelect;
