import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * A notification addressed to ONE PERSON, with their own read state.
 *
 * Deliberately not `activity_log`: that is one row per event for a whole
 * organization with no recipient and no read state. Assigning a course to
 * fifteen learners writes one activity row and fifteen notifications. The
 * full argument is in `0030_notifications.sql`.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The recipient — what makes this a notification and not a feed entry. */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** A key from `common/notifications.ts`. */
    type: text('type').notNull(),
    /** Composed at write time, so renaming a course cannot rewrite history. */
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    subjectType: text('subject_type'),
    subjectId: integer('subject_id'),
    /** Denormalised: the sentence must still read correctly after they leave. */
    actorName: text('actor_name'),
    /** NULL = unread. A timestamp rather than a flag — see the migration. */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_notifications_user_created').on(table.userId, table.createdAt),
    // The partial unread index is declared in the migration — Drizzle has no
    // expression for a WHERE clause on an index, and the migration is what
    // actually executes (§6.3).
    index('idx_notifications_unread').on(table.userId),
  ],
);
