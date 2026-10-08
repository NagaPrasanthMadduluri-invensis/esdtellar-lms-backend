import { sql } from 'drizzle-orm';
import { boolean, date, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

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
    /**
     * Replaces the built-in `EDS` at the front of a generated certificate
     * code. NULL means "use the default" rather than "unset" — see 0038.
     *
     * Read only when a code is GENERATED. An issued code is printed on a
     * document somebody holds and is what the public verify route takes, so
     * changing this must never rewrite one.
     */
    certificatePrefix: text('certificate_prefix'),
    /**
     * Who signs this tenant's certificates — a name and the title printed
     * under it. NULL is the normal case: the document then signs with the
     * organisation's own name, as every certificate did before 0039. Read at
     * render time, unlike the prefix, because it is presentation rather than
     * something the verify route looks up.
     */
    certificateSignatoryName: text('certificate_signatory_name'),
    certificateSignatoryTitle: text('certificate_signatory_title'),
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
    /**
     * Whether this tenant's learners may be emailed ANNOUNCEMENTS — a course
     * opening for self-enrolment, a session opening for booking (0037).
     *
     * Defaults 0, and that default is the thing standing between a deploy and
     * 500 unsolicited emails. Announcements go to a tenant's whole active
     * learner population; transactional mail is unaffected by this column.
     */
    emailAnnouncements: integer('email_announcements').notNull().default(0),
    /** Non-sequential PUBLIC id for URLs (/platform/organizations/:publicId). 0046. */
    publicId: uuid('public_id').defaultRandom(),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('organizations_one_platform')
      .on(table.isPlatform)
      .where(sql`${table.isPlatform}`),
    uniqueIndex('organizations_public_id_key').on(table.publicId),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type NewOrganizationRow = typeof organizations.$inferInsert;
