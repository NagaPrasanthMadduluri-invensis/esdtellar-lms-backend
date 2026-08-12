import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { scormPackages } from './scorm.schema';

/** `is_active`: 0 = draft (admin-only), 1 = published (visible to learners). */
export const courses = sqliteTable(
  'courses',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    description: text('description'),
    thumbnailUrl: text('thumbnail_url'),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_courses_active').on(table.isActive)],
);

export const courseModules = sqliteTable(
  'course_modules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    // Every progress query walks course -> modules -> lessons.
    index('idx_course_modules_course').on(table.courseId, table.isActive),
  ],
);

export const lessons = sqliteTable(
  'lessons',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    moduleId: integer('module_id')
      .notNull()
      .references(() => courseModules.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    contentType: text('content_type').notNull().default('video'),
    contentUrl: text('content_url'),
    durationMinutes: integer('duration_minutes'),
    sortOrder: integer('sort_order').notNull().default(0),
    isPreview: integer('is_preview').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    scormPackageId: integer('scorm_package_id').references(
      () => scormPackages.id,
      { onDelete: 'set null' },
    ),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('idx_lessons_module').on(table.moduleId, table.isActive)],
);

export type CourseRow = typeof courses.$inferSelect;
export type CourseModuleRow = typeof courseModules.$inferSelect;
export type LessonRow = typeof lessons.$inferSelect;
