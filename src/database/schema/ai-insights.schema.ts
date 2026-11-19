import {
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';

/**
 * Generated AI insights (0071, spec ai-insights.md Wave 1).
 *
 * ACTIVITY (`orgScope`): one latest row per (organization, subject, kind),
 * upserted by the nightly job or an on-demand refresh and read by the UI.
 * `subject_id` is a user id for `subject_type = 'learner'` and the org id for
 * `'org'`. `payload` holds the model's structured output and carries NO raw PII —
 * the feature layer sends only aggregates and ids to the model.
 */
export const aiInsights = pgTable(
  'ai_insights',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    subjectId: integer('subject_id').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    model: text('model').notNull(),
    generatedAt: timestamp('generated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('ai_insights_subject_key').on(
      table.organizationId,
      table.subjectType,
      table.subjectId,
      table.kind,
    ),
  ],
);
