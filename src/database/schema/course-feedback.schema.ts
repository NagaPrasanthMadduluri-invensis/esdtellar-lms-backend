import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { courses } from './courses.schema';
import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * An editable feedback form (0034).
 *
 * Seeded three per tenant — `standard`, `technical`, `compliance` — and the
 * admin may add more. `key` is unique per organization because the category
 * resolver looks a template up BY KEY: a Technical course finds the
 * `technical` template without anything having to store its id.
 *
 * `isSystem` marks the three seeded ones. They may be renamed and
 * re-questioned but never deleted — deleting `technical` would leave every
 * Technical course resolving to a template that is not there, with nothing on
 * screen to say why.
 */
export const feedbackTemplates = pgTable(
  'feedback_templates',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: integer('is_system').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('feedback_templates_organization_id_key_key').on(
      table.organizationId,
      table.key,
    ),
  ],
);

/**
 * One question on a template.
 *
 * `questionType` is one of the five in `common/feedback-questions.ts` and is
 * validated there rather than by a CHECK — the catalogue is code, and adding
 * a sixth type should not need a migration.
 *
 * `sortOrder` is STORED. A survey whose questions come back in a different
 * order for two learners is two different surveys.
 */
export const feedbackTemplateQuestions = pgTable(
  'feedback_template_questions',
  {
    id: serial('id').primaryKey(),
    templateId: integer('template_id')
      .notNull()
      .references(() => feedbackTemplates.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
    questionType: text('question_type').notNull(),
    prompt: text('prompt').notNull(),
    /** Only `choice` uses it: a jsonb array of strings. */
    options: jsonb('options').$type<string[] | null>(),
    isRequired: integer('is_required').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_feedback_questions_template').on(
      table.templateId,
      table.sortOrder,
    ),
  ],
);

/**
 * What a learner said about a COURSE.
 *
 * ACTIVITY, so every query over it carries `orgScope` and never
 * `contentScope` (§10.12): the course may be platform-owned and shared, but
 * an opinion about it belongs to exactly one tenant.
 *
 * Unlike `sessionFeedback` (0032), the admin DOES see who wrote it — the
 * owner chose "anonymous to everyone except the admin". Nothing else may
 * select `userId`.
 *
 * `answers` is keyed by question id and is NOT queryable as structured data.
 * Anything that needs reporting on must be promoted to a real column first,
 * the way `service_requests.timeline` was (§10.14).
 */
export const courseFeedback = pgTable(
  'course_feedback',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Which form they were shown. Kept when the template is deleted
     * (SET NULL) because the answers are keyed by ITS question ids, and
     * reading them back without knowing the form is guesswork.
     */
    templateId: integer('template_id').references(() => feedbackTemplates.id, {
      onDelete: 'set null',
    }),
    answers: jsonb('answers')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** One person, one opinion per course. Submitting again replaces it. */
    unique('course_feedback_course_id_user_id_key').on(
      table.courseId,
      table.userId,
    ),
    index('idx_course_feedback_course').on(table.courseId),
    index('idx_course_feedback_org_created').on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);
