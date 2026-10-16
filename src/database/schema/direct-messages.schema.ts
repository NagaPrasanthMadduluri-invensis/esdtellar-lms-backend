import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * A direct message between two people in one organization (0054).
 *
 * A conversation is DERIVED, not stored: it is the set of messages between two
 * user ids, so there is no conversations table. `readAt` is the recipient's
 * read state; the unread badge counts NULLs addressed to the caller (partial
 * index). Activity — every read is org-scoped, so a thread never crosses a
 * tenant boundary.
 */
export const directMessages = pgTable(
  'direct_messages',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientId: integer('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    /** NULL until the recipient opens the thread. */
    readAt: timestamp('read_at', { mode: 'string', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_dm_recipient_unread').on(table.recipientId, table.organizationId),
    index('idx_dm_sender_recipient').on(table.senderId, table.recipientId, table.createdAt),
    index('idx_dm_recipient_sender').on(table.recipientId, table.senderId, table.createdAt),
  ],
);

export type DirectMessageRow = typeof directMessages.$inferSelect;
