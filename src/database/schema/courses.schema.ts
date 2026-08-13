import { boolean, index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

import { scormPackages } from './scorm.schema';

/** `is_active`: false = draft (admin-only), true = published (visible to learners). */
export const courses = pgTable(
  'courses',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    thumbnailUrl: text('thumbnail_url'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_courses_active').on(table.isActive)],
);

export const courseModules = pgTable(
  'course_modules',
  {
    id: serial('id').primaryKey(),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_course_modules_course').on(table.courseId, table.isActive),
  ],
);

export const lessons = pgTable(
  'lessons',
  {
    id: serial('id').primaryKey(),
    moduleId: integer('module_id')
      .notNull()
      .references(() => courseModules.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    contentType: text('content_type').notNull().default('video'),
    contentUrl: text('content_url'),
    durationMinutes: integer('duration_minutes'),
    sortOrder: integer('sort_order').notNull().default(0),
    isPreview: boolean('is_preview').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    scormPackageId: integer('scorm_package_id').references(
      () => scormPackages.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('idx_lessons_module').on(table.moduleId, table.isActive)],
);

export type CourseRow = typeof courses.$inferSelect;
export type CourseModuleRow = typeof courseModules.$inferSelect;
export type LessonRow = typeof lessons.$inferSelect;
