import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { scormPackages } from './scorm.schema';

/** `is_active`: 0 = draft (admin-only), 1 = published (visible to learners). */
export const courses = pgTable(
  'courses',
  {
    id: serial('id').primaryKey(),
    /**
     * The owner: a real org, or the platform org for global content (§3.4).
     */
    organizationId: integer('organization_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    thumbnailUrl: text('thumbnail_url'),
    isActive: integer('is_active').notNull().default(1),
    /**
     * One of `COURSE_CATEGORIES` (`common/course-taxonomy.ts`), or null for a
     * course nobody has filed yet. Closed by the DTO, free text in Postgres —
     * the category set is a product decision that must not need a migration.
     */
    category: text('category'),
    /**
     * "Everyone must do this." A compliance course counts as mandatory
     * whether or not this is set — that implication lives in `isMandatory()`,
     * never in a second copy of the rule at a call site.
     */
    isMandatory: integer('is_mandatory').notNull().default(0),
    /**
     * Renewal cadence in months; null means it does not expire. RECORDED
     * ONLY — nothing ages a completion out yet. See the migration.
     */
    expiryMonths: integer('expiry_months'),
    /** Comma-separated free text, for search. Nothing branches on a tag. */
    tags: text('tags'),
    /**
     * Archive — a third state, orthogonal to published/draft, which is why it
     * is not a value of `isActive`. Null means active. An archived course
     * keeps its publish state so restoring returns it to what it was.
     */
    archivedAt: timestamp('archived_at', { mode: 'string', withTimezone: true }),
    /**
     * Set when this course IS a live/offline session rather than a catalog
     * course: the session's companion training, holding one lesson of
     * `content_type = 'session'`.
     *
     * Declared without `.references()` on purpose — sessions.schema.ts already
     * imports this file for `courses`, and adding the reverse reference here
     * would make the two modules circular. The foreign key (and its
     * ON DELETE CASCADE, which is what tears a training down with its session)
     * lives in migration 0005.
     */
    sessionId: integer('session_id'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_courses_active').on(table.isActive),
    // One training course per session, and the lookup for "is this course a
    // session training?" that the admin list and certificate guard both make.
    uniqueIndex('courses_session_unique').on(table.sessionId),
    // Catalogue reads filter by org (or org + platform) and active status —
    // this is the composite from spec §3.7.
    index('idx_courses_org_active').on(table.organizationId, table.isActive),
    // The library's default read: this org's courses that are not archived.
    index('idx_courses_org_archived').on(table.organizationId, table.archivedAt),
    index('idx_courses_org_category').on(table.organizationId, table.category),
  ],
);

export const courseModules = pgTable(
  'course_modules',
  {
    id: serial('id').primaryKey(),
    /** Content: the owning course's org. */
    organizationId: integer('organization_id').notNull(),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
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
    /** Content: the owning course's org. */
    organizationId: integer('organization_id').notNull(),
    /**
     * NULLABLE since 0020. Null means STAGED: authored but not yet placed in
     * the course, so invisible to learners and counting for nothing — see the
     * migration, which explains why that is what keeps ~89 existing queries
     * correct without a rewrite.
     */
    moduleId: integer('module_id')
      // SET NULL, not cascade: deleting a module must unlink its lessons, not
      // destroy them. See migration 0020.
      .references(() => courseModules.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    /**
     * `video` | `scorm` | `document` | `quiz` | `session` | `external`.
     *
     * A `document` lesson's file is either uploaded (documentKey) or linked
     * (contentUrl) — the same two options every supporting resource has.
     */
    /**
     * The lesson's course, ALWAYS set. A lesson used to reach its course only
     * through its module, so it could not exist without one — this column is
     * what lets a lesson be authored first and arranged into a module after
     * (migration 0020).
     */
    courseId: integer('course_id').notNull(),
    contentType: text('content_type').notNull().default('video'),
    contentUrl: text('content_url'),
    // R2 object keys, not URLs — playback links are presigned per request.
    videoKey: text('video_key'),
    captionKey: text('caption_key'),
    /** Real length of the uploaded file, read from its metadata on upload. */
    videoDurationSeconds: integer('video_duration_seconds'),
    /**
     * The primary document, when the lesson IS a document and it was uploaded
     * rather than linked. An R2 object key, never a URL — playback and download
     * links are presigned per request, same as video.
     */
    documentKey: text('document_key'),
    documentName: text('document_name'),
    documentMime: text('document_mime'),
    documentSizeBytes: integer('document_size_bytes'),
    /**
     * The lesson's stated length. Read from the file for an uploaded video,
     * from the manifest for SCORM when it declares one, and typed by the admin
     * for documents — which have no runtime to read. This is what learning
     * hours credits for everything except video and SCORM, which report their
     * own measured time instead (§10.4).
     */
    durationMinutes: integer('duration_minutes'),
    sortOrder: integer('sort_order').notNull().default(0),
    isPreview: integer('is_preview').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    scormPackageId: integer('scorm_package_id').references(
      () => scormPackages.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_lessons_module').on(table.moduleId, table.isActive),
    // Joined by ScormRepository.hasAccess, findAccessiblePackage and the
    // content middleware's entitlement UNION — the last of which runs on every
    // package launch (§7.4).
    index('idx_lessons_scorm_package').on(table.scormPackageId),
  ],
);

/**
 * Supporting material hanging off a lesson: slides, a handout, a spec, a link
 * to something external. Reference material, not content to be completed — a
 * resource carries no duration and never reaches learning hours, so there is
 * still exactly one number per lesson that counts.
 *
 * `source` says which half of the row is live: `upload` fills fileKey/fileName/
 * mimeType/fileSizeBytes, `link` fills url.
 */
export const lessonResources = pgTable(
  'lesson_resources',
  {
    id: serial('id').primaryKey(),
    /** Content: the owning course's org. */
    organizationId: integer('organization_id').notNull(),
    lessonId: integer('lesson_id')
      .notNull()
      .references(() => lessons.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** pdf | ppt | doc | xls | link | other — drives the icon, nothing else. */
    resourceType: text('resource_type').notNull().default('other'),
    source: text('source', { enum: ['upload', 'link'] }).notNull(),
    fileKey: text('file_key'),
    fileName: text('file_name'),
    fileSizeBytes: integer('file_size_bytes'),
    mimeType: text('mime_type'),
    url: text('url'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_lesson_resources_org_lesson').on(table.organizationId, table.lessonId),
    // Always read for one lesson, in display order.
    index('idx_lesson_resources_lesson').on(table.lessonId, table.sortOrder),
  ],
);

export type CourseRow = typeof courses.$inferSelect;
export type CourseModuleRow = typeof courseModules.$inferSelect;
export type LessonRow = typeof lessons.$inferSelect;
export type LessonResourceRow = typeof lessonResources.$inferSelect;
