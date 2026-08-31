import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * A tenant. Every other table's `organization_id` points here, plus one
 * reserved row with `isPlatform = true` that owns the global course/SCORM
 * catalogue and never owns a session (§3.3, §3.4).
 *
 * The partial unique index guarantees at most one platform row can ever
 * exist; the platform org's id is looked up once at boot and injected as a
 * provider rather than hard-coded in a query.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logoUrl: text('logo_url'),
    isPlatform: boolean('is_platform').notNull().default(false),
    isActive: integer('is_active').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('organizations_one_platform')
      .on(table.isPlatform)
      .where(sql`${table.isPlatform}`),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
