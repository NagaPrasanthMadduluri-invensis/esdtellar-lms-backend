import {
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'string' });

/**
 * The security incident register (0066). PLATFORM data: no organization_id,
 * read only by @PlatformAdmin routes. Deadlines are derived in
 * common/incidents.ts, never stored.
 */
export const securityIncidents = pgTable(
  'security_incidents',
  {
    id: serial('id').primaryKey(),
    refNo: text('ref_no').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    severity: text('severity').notNull().default('medium'),
    status: text('status').notNull().default('open'),
    discoveredAt: ts('discovered_at').notNull(),
    assessment: text('assessment').notNull().default('undecided'),
    assessedAt: ts('assessed_at'),
    dataCategories: text('data_categories'),
    individualsAffected: integer('individuals_affected'),
    cause: text('cause'),
    containment: text('containment'),
    clientsNotifiedAt: ts('clients_notified_at'),
    regulatorNotifiedAt: ts('regulator_notified_at'),
    regulatorReference: text('regulator_reference'),
    individualsNotifiedAt: ts('individuals_notified_at'),
    closedAt: ts('closed_at'),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('idx_security_incidents_discovered').on(t.discoveredAt)],
);

export const securityIncidentOrganizations = pgTable(
  'security_incident_organizations',
  {
    incidentId: integer('incident_id')
      .notNull()
      .references(() => securityIncidents.id, { onDelete: 'cascade' }),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.incidentId, t.organizationId] }),
    index('idx_security_incident_orgs_org').on(t.organizationId),
  ],
);

/** The incident's append-only timeline. */
export const securityIncidentEvents = pgTable(
  'security_incident_events',
  {
    id: serial('id').primaryKey(),
    incidentId: integer('incident_id')
      .notNull()
      .references(() => securityIncidents.id, { onDelete: 'cascade' }),
    actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name'),
    kind: text('kind').notNull(),
    note: text('note'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('idx_security_incident_events_incident').on(t.incidentId, t.createdAt)],
);
