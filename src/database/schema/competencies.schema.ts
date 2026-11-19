import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { courses } from './courses.schema';
import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * The competency catalogue (0070).
 *
 * CONTENT, read with `contentScope`: the platform organization owns a shared
 * starter set that every tenant sees, and a tenant may add its own skills
 * (private to it). Mirrors how a platform-owned course is shared.
 *
 * `slug` is unique per organization so "Project Management" typed twice resolves
 * to one skill — see `common/competencies.ts` for the normalization.
 */
export const skills = pgTable(
  'skills',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    domain: text('domain'),
    isActive: integer('is_active').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('skills_organization_id_slug_key').on(
      table.organizationId,
      table.slug,
    ),
  ],
);

/**
 * Which skills a course imparts, and at what level (`common/competencies.ts`).
 * CONTENT — the course may be platform-owned and shared.
 */
export const courseSkills = pgTable(
  'course_skills',
  {
    id: serial('id').primaryKey(),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    skillId: integer('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('intermediate'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('course_skills_course_id_skill_id_key').on(
      table.courseId,
      table.skillId,
    ),
    index('idx_course_skills_skill').on(table.skillId),
  ],
);

/**
 * Competencies a learner has gained, recorded on course completion.
 *
 * ACTIVITY, so every query carries `orgScope`: a gained competency belongs to
 * the learner's own organization. One row per (user, skill) — completing another
 * course that imparts it UPGRADES `level` (never downgrades) and stamps
 * `last_reinforced_at`.
 */
export const userSkills = pgTable(
  'user_skills',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skillId: integer('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('intermediate'),
    sourceCourseId: integer('source_course_id').references(() => courses.id, {
      onDelete: 'set null',
    }),
    earnedAt: timestamp('earned_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    lastReinforcedAt: timestamp('last_reinforced_at', {
      mode: 'string',
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('user_skills_user_id_skill_id_key').on(
      table.userId,
      table.skillId,
    ),
    index('idx_user_skills_org_user').on(table.organizationId, table.userId),
    index('idx_user_skills_skill').on(table.skillId),
  ],
);
