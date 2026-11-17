import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * Append-only consent history (0065). One row per acknowledgement, optional
 * choice change, or withdrawal step. Never updated, except that the retention
 * sweep nulls `ip_address` / `user_agent` when it anonymises the user.
 */
export const consentEvents = pgTable(
  'consent_events',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** common/consent.ts CONSENT_EVENTS. */
    event: text('event').notNull(),
    noticeVersion: text('notice_version'),
    details: jsonb('details'),
    source: text('source'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('idx_consent_events_user').on(t.userId, t.createdAt)],
);
