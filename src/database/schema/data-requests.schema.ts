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
 * A data-subject request to CORRECT or DELETE personal data (0056), filed from
 * the "My Data" self-service.
 *
 * ACTIVITY, owned by one tenant, so every read is `orgScope` (§10.12). The row
 * is a LOGGED request, not an execution: an admin reviews and actions it,
 * because deleting learning records reaches certificates, hours, analytics and
 * the audit trail (see the migration header).
 */
export const dataRequests = pgTable(
  'data_requests',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The data subject who filed it. */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'correction' | 'deletion' (common/data-requests.ts). */
    type: text('type').notNull(),
    /** 'open' | 'in_progress' | 'resolved' | 'rejected'. Starts 'open'. */
    status: text('status').notNull().default('open'),
    /** What to correct, or why to delete. Capped at DESCRIPTION_MAX_LENGTH. */
    details: text('details'),
    /** What the admin wrote back; visible to the subject. */
    adminNote: text('admin_note'),
    /** The admin who actioned it. SET NULL if that admin is later removed. */
    handledBy: integer('handled_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    handledAt: timestamp('handled_at', { mode: 'string', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_data_requests_org_status').on(
      table.organizationId,
      table.status,
      table.createdAt.desc(),
    ),
    index('idx_data_requests_user').on(table.userId, table.createdAt.desc()),
  ],
);

export type DataRequestRow = typeof dataRequests.$inferSelect;
export type NewDataRequestRow = typeof dataRequests.$inferInsert;
