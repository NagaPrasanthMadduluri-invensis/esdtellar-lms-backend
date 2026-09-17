import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * A tenant asking for more seats.
 *
 * Its own table, not a `service_requests` row: a service request goes to a
 * sales conversation and carries a questionnaire nothing queries, while this
 * is an account change with one number in it that the super admin acts on
 * directly — approving it writes `organizations.seatLimit`.
 *
 * A partial unique index allows only ONE pending request per organization, so
 * the platform is never guessing which of three queued asks is current.
 */
export const seatRequests = pgTable(
  'seat_requests',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    requestedSeats: integer('requested_seats').notNull(),
    /** The picture WHEN THEY ASKED — not recomputed on read. */
    currentLimit: integer('current_limit'),
    currentUsed: integer('current_used').notNull(),
    reason: text('reason'),
    /** pending | approved | declined. Only the platform moves it. */
    status: text('status').notNull().default('pending'),
    responseNote: text('response_note'),
    /** What was granted, which may differ from what was asked. */
    approvedSeats: integer('approved_seats'),
    requestedBy: integer('requested_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    contactName: text('contact_name').notNull(),
    contactEmail: text('contact_email').notNull(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_seat_requests_org_created').on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    index('idx_seat_requests_status').on(table.status, table.createdAt.desc()),
    uniqueIndex('idx_seat_requests_one_open').on(table.organizationId),
  ],
);

export type SeatRequestRow = typeof seatRequests.$inferSelect;
