import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * Mirrors `service_requests`, added by `0021_service_requests.sql`.
 *
 * An org admin asking Edstellar for a service — a TNA, a leadership programme,
 * a platform. Read that migration for why `answers` is a document rather than
 * columns, and why `timeline` and `budget` are lifted out of it.
 *
 * A request is ORG-SCOPED ACTIVITY, never content: `orgScope()`, never
 * `contentScope()`. The service CATALOGUE is shared by every tenant; a
 * tenant's requests against it are theirs alone, and the two must not be
 * confused (BACKEND_STRUCTURE §10.12 records what happens when they are).
 */
export const serviceRequests = pgTable(
  'service_requests',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Human-facing reference, e.g. `REQ-2026-0007`. Unique within the org. */
    refNo: text('ref_no').notNull(),
    /** One of `SERVICE_NAMES` in `common/edstellar-services.ts`. */
    service: text('service').notNull(),
    /** The per-service questionnaire as answered. Not queryable — by design. */
    answers: jsonb('answers').notNull().default({}),
    timeline: text('timeline'),
    budget: text('budget'),
    /** One of `REQUEST_STATUSES`. Only Edstellar moves it past `pending`. */
    status: text('status').notNull().default('pending'),
    /** What Edstellar wrote back; shown to the requesting admin. */
    responseNote: text('response_note'),
    /**
     * ON DELETE SET NULL — deleting the admin must not erase the request.
     * `contactName` / `contactEmail` are the denormalised copies that survive
     * it, and are what the list renders. Same reasoning as `activityLog`.
     */
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
    // The only read: one org's requests, newest first. No sort step.
    index('idx_service_requests_org_created').on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    uniqueIndex('idx_service_requests_org_ref').on(
      table.organizationId,
      table.refNo,
    ),
  ],
);

export type ServiceRequestRow = typeof serviceRequests.$inferSelect;
export type NewServiceRequestRow = typeof serviceRequests.$inferInsert;
