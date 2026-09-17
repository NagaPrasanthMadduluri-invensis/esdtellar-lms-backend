import { sql } from 'drizzle-orm';
import { boolean, date, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

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
    /* ── Tenant profile & contract, added by 0026_tenant_profile.sql.
           All nullable: an organization created before the console existed,
           or one provisioned in a hurry, is still a valid tenant. ── */
    industry: text('industry'),
    region: text('region'),
    /** Denormalised on purpose — the commercial contact is often not a user. */
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    contractStart: date('contract_start'),
    /** What the renewal warning derives from. Never a stored status. */
    contractEnd: date('contract_end'),
    /** numeric, not float — this is money. */
    contractValue: numeric('contract_value', { precision: 14, scale: 2 }),
    /** One of `PLANS` in `common/tenant-account.ts`. */
    plan: text('plan'),
    /** One of `BILLING_CYCLES`. */
    billingCycle: text('billing_cycle'),
    /** Account-manager notes. Never shown to the tenant. */
    notes: text('notes'),
    /**
     * Seats, added by `0028_seat_limits.sql`. NULL = unlimited, which is every
     * tenant that predates it.
     *
     * A seat is an ACTIVE LEARNER — not every user row. Deactivated learners
     * do not count (so freeing a seat by deactivating works, which is what an
     * admin at the cap will try), and admins, managers and trainers are not
     * seats at all. Enforced on learner create and reactivate; a limit that is
     * only displayed is worse than none.
     */
    seatLimit: integer('seat_limit'),
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
