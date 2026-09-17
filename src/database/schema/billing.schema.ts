import {
  date,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * Mirrors `invoices`, added by `0027_billing.sql`.
 *
 * `status` holds only what a human decided — draft, issued, void. **Paid and
 * overdue are DERIVED** (`common/billing.ts`) from the payments against the
 * invoice and the calendar. Do not add a `paid` column: it would need
 * reconciling with `invoice_payments`, and the first time the two disagreed
 * the flag would contradict the figures printed beside it.
 *
 * `amount` is `numeric`, not a float. A float column does not sum to what a
 * human adds up, and this is the table somebody reconciles against a bank
 * statement. `pg` returns it as a STRING — convert once at the service
 * boundary, never do arithmetic on the raw value.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Unique PLATFORM-WIDE — these go out to customers and into a ledger. */
    invoiceNo: text('invoice_no').notNull(),
    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('INR'),
    /** One of `INVOICE_STATUSES`. Never paid/overdue. */
    status: text('status').notNull().default('draft'),
    description: text('description'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_invoices_org_issued').on(table.organizationId, table.issueDate.desc()),
    index('idx_invoices_due').on(table.dueDate),
    uniqueIndex('idx_invoices_no').on(table.invoiceNo),
  ],
);

export type InvoiceRow = typeof invoices.$inferSelect;

/**
 * What actually arrived against an invoice.
 *
 * Its own table rather than a `paid` flag, because an invoice can be
 * part-paid, paid in instalments, or paid against a reference somebody has to
 * find later — none of which a boolean can hold.
 */
export const invoicePayments = pgTable(
  'invoice_payments',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invoiceId: integer('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    paidOn: date('paid_on').notNull(),
    /** One of `PAYMENT_METHODS`. Text — payment rails change often. */
    method: text('method'),
    /** The bank/UTR reference somebody will search for. */
    reference: text('reference'),
    notes: text('notes'),
    /** ON DELETE SET NULL — the payment still happened. */
    recordedBy: integer('recorded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_invoice_payments_invoice').on(table.invoiceId, table.paidOn),
    index('idx_invoice_payments_org').on(table.organizationId, table.paidOn.desc()),
  ],
);

export type InvoicePaymentRow = typeof invoicePayments.$inferSelect;
