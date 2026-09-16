import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

import { users } from './users.schema';

/**
 * Mirrors `activity_log`, added by `0018_workforce_and_activity_log.sql`.
 *
 * What has been happening in this organization, for the admin dashboard's
 * Recent Activity panel. It is a **product feature, not an audit trail** — the
 * writes are best-effort (BACKEND_STRUCTURE §8.4), so the entries that are
 * missing are precisely the ones whose write failed. Read that sentence again
 * before using this table to answer "did X really happen".
 *
 * An activity row is ORG-SCOPED activity, never content: `orgScope()`, never
 * `contentScope()`. A platform-owned course uploaded once must not appear in
 * every tenant's activity feed as though their own admin had done it.
 */
export const activityLog = pgTable(
  'activity_log',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    /** One of `ACTIVITY_TYPES` in `common/activity.ts`. */
    type: text('type').notNull(),
    /** The entry's heading, e.g. "User created". */
    title: text('title').notNull(),
    /** The entry's body, e.g. "Added Nisha Menon (learner, HR)". */
    detail: text('detail'),
    /**
     * ON DELETE SET NULL in SQL — deleting the admin must not erase the record
     * of what they did. `actorName` is the denormalised copy that survives it,
     * and is what the panel actually renders.
     */
    actorUserId: integer('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    actorName: text('actor_name').notNull(),
    /** A loose reference — deliberately not a foreign key. See the migration. */
    subjectType: text('subject_type'),
    subjectId: integer('subject_id'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The only read: newest first within one org. Serves it with no sort step.
    index('idx_activity_log_org_created').on(
      table.organizationId,
      table.createdAt.desc(),
    ),
  ],
);

export type ActivityLogRow = typeof activityLog.$inferSelect;
export type NewActivityLogRow = typeof activityLog.$inferInsert;
