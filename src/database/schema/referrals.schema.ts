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
 * Mirrors `referrals`, added by `0051_referrals.sql`.
 *
 * An org admin referring another COMPANY to become a Spectra LMS customer. Read
 * that migration for why the reward tier is DERIVED (never a column), why the
 * referrer's name and email are denormalised, and why the prospect's email is
 * globally unique (first-touch attribution).
 *
 * A referral is ORG-SCOPED ACTIVITY, never content: `orgScope()`, never
 * `contentScope()`. Edstellar's own queue reads every tenant's referrals
 * through a separate `@PlatformAdmin()` route (§10.12, §10.36).
 */
export const referrals = pgTable(
  'referrals',
  {
    id: serial('id').primaryKey(),
    /** The REFERRER's organization. */
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Human-facing reference, e.g. `REF-2026-0007`. Unique within the org. */
    refNo: text('ref_no').notNull(),
    /**
     * ON DELETE SET NULL — deleting the admin must not erase the referral.
     * `referrerName` / `referrerEmail` are the denormalised copies that survive
     * it. Same reasoning as `serviceRequests.requestedBy`.
     */
    referredBy: integer('referred_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    referrerName: text('referrer_name').notNull(),
    referrerEmail: text('referrer_email').notNull(),
    /** The prospect: the company and the person to contact. */
    companyName: text('company_name').notNull(),
    contactName: text('contact_name').notNull(),
    contactEmail: text('contact_email').notNull(),
    contactPhone: text('contact_phone'),
    industry: text('industry'),
    country: text('country'),
    teamSize: text('team_size'),
    notes: text('notes'),
    /** One of `REFERRAL_STATUSES`. Only Edstellar moves it past `invited`. */
    status: text('status').notNull().default('invited'),
    /** What Edstellar wrote back; shown to the referring admin. */
    platformNote: text('platform_note'),
    /**
     * Set when the referral converts — the tenant the prospect became.
     * ON DELETE SET NULL: removing a tenant must not delete the referral that
     * won it. The referrer sees only that it converted, never the org's data.
     */
    convertedOrganizationId: integer('converted_organization_id').references(
      () => organizations.id,
      { onDelete: 'set null' },
    ),
    convertedAt: timestamp('converted_at', {
      mode: 'string',
      withTimezone: true,
    }),
    inviteEmailAt: timestamp('invite_email_at', {
      mode: 'string',
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_referrals_org_created').on(
      table.organizationId,
      table.createdAt.desc(),
    ),
    uniqueIndex('idx_referrals_org_ref').on(table.organizationId, table.refNo),
    index('idx_referrals_status').on(table.status),
    // The partial lower(contact_email) unique index is declared in the
    // migration — Drizzle has no expression index for it, and the migration is
    // what executes (§6.3).
  ],
);

export type ReferralRow = typeof referrals.$inferSelect;
export type NewReferralRow = typeof referrals.$inferInsert;
