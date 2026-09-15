import { index, integer, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { courses } from './courses.schema';
import { users } from './users.schema';

/**
 * A curated, ordered path of existing courses (`specs/learning-journeys.md`
 * §3.1). `is_active` follows the same draft/published meaning as
 * `courses.isActive`.
 */
export const journeys = pgTable(
  'journeys',
  {
    id: serial('id').primaryKey(),
    /** Content: the owner org, or the platform org for a global journey. */
    organizationId: integer('organization_id').notNull(),
    title: text('title').notNull(),
    /** Capped at `DESCRIPTION_MAX_LENGTH` by the DTO. */
    description: text('description'),
    /** e.g. "Sales · Role Path". */
    tag: text('tag'),
    /** Comma-separated, mirroring the mock's `skills[]`. */
    skills: text('skills'),
    /** Same storage and rules as a course thumbnail (§10.10). */
    thumbnailUrl: text('thumbnail_url'),
    /** What the badge earned on completion is called. */
    badgeLabel: text('badge_label').notNull(),
    /** A lucide icon name, from a closed list. */
    badgeIcon: text('badge_icon').notNull().default('award'),
    /** Added to the leaderboard on completion — §4.4, one column per journey
     * rather than a flat constant, because a 3-course path and a 12-course
     * path are not worth the same. */
    pointsBonus: integer('points_bonus').notNull().default(200),
    isActive: integer('is_active').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_journeys_org_active').on(table.organizationId, table.isActive),
  ],
);

/**
 * A journey's member courses, in order. `organizationId` is denormalised from
 * the parent journey so the join can be scoped without reaching `journeys`
 * first (`contentScope` via its journey, per §3.2).
 */
export const journeyCourses = pgTable(
  'journey_courses',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    journeyId: integer('journey_id')
      .notNull()
      .references(() => journeys.id, { onDelete: 'cascade' }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    /** The sequence. Sequential gating (§4.3) reads this order. */
    sortOrder: integer('sort_order').notNull().default(0),
    /** Optional steps do not gate and do not block completion. */
    isRequired: integer('is_required').notNull().default(1),
  },
  (table) => [
    unique('journey_courses_journey_course_unique').on(
      table.journeyId,
      table.courseId,
    ),
    index('idx_journey_courses_course').on(table.courseId),
  ],
);

/**
 * Who is on a journey, and when they finished it. `completedAt` is the ONLY
 * stored progress (§3.3, §7.1) — percentage, current step and per-course
 * status are all derived from `user_lesson_completions`, the same way a
 * session's "in progress" is derived rather than stored (§10.7).
 */
export const journeyEnrollments = pgTable(
  'journey_enrollments',
  {
    id: serial('id').primaryKey(),
    /** Activity: the learner's org. */
    organizationId: integer('organization_id').notNull(),
    journeyId: integer('journey_id')
      .notNull()
      .references(() => journeys.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    assignedBy: integer('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Nullable, same shape as `user_course_assignments.due_date`. */
    dueDate: text('due_date'),
    /** NULL until every required course in the journey is complete. */
    completedAt: timestamp('completed_at', { mode: 'string', withTimezone: true }),
  },
  (table) => [
    unique('journey_enrollments_user_journey_unique').on(
      table.userId,
      table.journeyId,
    ),
    index('idx_je_org_user').on(table.organizationId, table.userId),
  ],
);

/**
 * Every badge a learner has earned, persisted on award and never recomputed
 * (§4.5). `badgeKey` is one of the ids in `common/badges.ts`, or
 * `journey:<id>` for a per-journey badge (`journeyBadgeKey()`), in which case
 * `journeyId` is set and the label/icon are read off the journey row rather
 * than the catalogue.
 */
export const userBadges = pgTable(
  'user_badges',
  {
    id: serial('id').primaryKey(),
    /** Activity: the earner's org. */
    organizationId: integer('organization_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    badgeKey: text('badge_key').notNull(),
    journeyId: integer('journey_id').references(() => journeys.id, {
      onDelete: 'cascade',
    }),
    earnedAt: timestamp('earned_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('user_badges_user_badge_unique').on(table.userId, table.badgeKey),
    index('idx_user_badges_org_user').on(table.organizationId, table.userId),
  ],
);

export type JourneyRow = typeof journeys.$inferSelect;
export type NewJourneyRow = typeof journeys.$inferInsert;
export type JourneyCourseRow = typeof journeyCourses.$inferSelect;
export type NewJourneyCourseRow = typeof journeyCourses.$inferInsert;
export type JourneyEnrollmentRow = typeof journeyEnrollments.$inferSelect;
export type NewJourneyEnrollmentRow = typeof journeyEnrollments.$inferInsert;
export type UserBadgeRow = typeof userBadges.$inferSelect;
export type NewUserBadgeRow = typeof userBadges.$inferInsert;
