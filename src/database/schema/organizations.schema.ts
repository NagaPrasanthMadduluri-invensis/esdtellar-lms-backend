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
    /**
     * Bumped in the same transaction as any write to `roles` or
     * `role_permissions`. The JWT carries the value it was signed with and
     * `AuthGuard` compares the two, so a permission change signs THIS
     * organization out and no other — how decision 5 ("a permission change
     * forces a re-login") is delivered. `specs/rbac.md` §3.6.
     *
     * Deliberately not TTL-cached: `scorm/entitlement-cache.ts` says in its
     * own docblock that its stale-positive pattern must not be reused where a
     * capability is granted.
     */
    permVersion: integer('perm_version').notNull().default(1),
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
