import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { invoicePayments, invoices } from '@/database/schema';

export interface InvoiceRowWithPaid {
  id: number;
  organization_id: number;
  organization_name: string;
  invoice_no: string;
  issue_date: string;
  due_date: string;
  /** `numeric` arrives as a STRING from pg — converted at the service. */
  amount: string;
  currency: string;
  status: string;
  description: string | null;
  notes: string | null;
  paid: string;
  payment_count: number;
  created_at: string;
}

/**
 * Billing queries.
 *
 * Every read here is PLATFORM-WIDE and sits behind `@PlatformAdmin()`. There
 * is deliberately no org-scoped counterpart: a tenant does not manage its own
 * invoices in this product, and adding a tenant-facing read would need its own
 * controller and its own decision about what a customer may see.
 */
@Injectable()
export class BillingRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Invoices with what has been paid against each, in ONE query.
   *
   * The payment total is a correlated subquery rather than a second round trip
   * per invoice (§7.1) — the overview lists every tenant's invoices at once.
   */
  async listInvoices(filters: {
    organizationId?: number;
    status?: string;
    limit: number;
    offset: number;
  }) {
    const orgFilter = filters.organizationId
      ? sql`AND i.organization_id = ${filters.organizationId}`
      : sql``;
    const statusFilter = filters.status
      ? sql`AND i.status = ${filters.status}`
      : sql``;

    return this.db.all<InvoiceRowWithPaid>(sql`
      SELECT i.id, i.organization_id, o.name AS organization_name,
             i.invoice_no, i.issue_date, i.due_date, i.amount, i.currency,
             i.status, i.description, i.notes, i.created_at,
             COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                        WHERE p.invoice_id = i.id), 0) AS paid,
             (SELECT COUNT(*)::int FROM invoice_payments p
               WHERE p.invoice_id = i.id) AS payment_count
        FROM invoices i
        JOIN organizations o ON o.id = i.organization_id
       WHERE TRUE ${orgFilter} ${statusFilter}
       ORDER BY i.issue_date DESC, i.id DESC
       LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
  }

  async findInvoice(id: number) {
    const rows = await this.db.all<InvoiceRowWithPaid>(sql`
      SELECT i.id, i.organization_id, o.name AS organization_name,
             i.invoice_no, i.issue_date, i.due_date, i.amount, i.currency,
             i.status, i.description, i.notes, i.created_at,
             COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                        WHERE p.invoice_id = i.id), 0) AS paid,
             (SELECT COUNT(*)::int FROM invoice_payments p
               WHERE p.invoice_id = i.id) AS payment_count
        FROM invoices i
        JOIN organizations o ON o.id = i.organization_id
       WHERE i.id = ${id}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async listPayments(invoiceId: number) {
    return this.db.all<{
      id: number;
      amount: string;
      paid_on: string;
      method: string | null;
      reference: string | null;
      notes: string | null;
      recorded_by_name: string | null;
    }>(sql`
      SELECT p.id, p.amount, p.paid_on, p.method, p.reference, p.notes,
             CASE WHEN u.id IS NULL THEN NULL
                  ELSE u.first_name || ' ' || u.last_name END AS recorded_by_name
        FROM invoice_payments p
        LEFT JOIN users u ON u.id = p.recorded_by
       WHERE p.invoice_id = ${invoiceId}
       ORDER BY p.paid_on, p.id
    `);
  }

  /**
   * Money across the whole platform, in one query.
   *
   * Summed in SQL (§7.2), and `numeric` throughout so the totals are exact
   * rather than a float approximation of somebody's ledger.
   */
  async platformTotals() {
    const rows = await this.db.all<{
      invoiced: string;
      collected: string;
      outstanding: string;
      overdue_amount: string;
      overdue_count: number;
      draft_count: number;
    }>(sql`
      WITH billed AS (
        SELECT i.id, i.amount, i.due_date, i.status,
               COALESCE((SELECT SUM(p.amount) FROM invoice_payments p
                          WHERE p.invoice_id = i.id), 0) AS paid
          FROM invoices i
      )
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'issued'), 0) AS invoiced,
        COALESCE(SUM(paid)   FILTER (WHERE status = 'issued'), 0) AS collected,
        COALESCE(SUM(GREATEST(amount - paid, 0))
                   FILTER (WHERE status = 'issued'), 0)          AS outstanding,
        -- Overdue is DERIVED here too, from the same rule the service uses:
        -- issued, not fully paid, past its due date.
        COALESCE(SUM(GREATEST(amount - paid, 0))
                   FILTER (WHERE status = 'issued'
                             AND paid < amount
                             AND due_date < CURRENT_DATE), 0)    AS overdue_amount,
        COUNT(*) FILTER (WHERE status = 'issued'
                           AND paid < amount
                           AND due_date < CURRENT_DATE)::int     AS overdue_count,
        COUNT(*) FILTER (WHERE status = 'draft')::int            AS draft_count
      FROM billed
    `);
    return rows[0];
  }

  /** Per-tenant money, for the overview's account table. */
  async totalsByOrganization() {
    return this.db.all<{
      organization_id: number;
      invoiced: string;
      collected: string;
      outstanding: string;
      overdue_count: number;
    }>(sql`
      SELECT i.organization_id,
             COALESCE(SUM(i.amount) FILTER (WHERE i.status = 'issued'), 0) AS invoiced,
             COALESCE(SUM(pay.paid) FILTER (WHERE i.status = 'issued'), 0) AS collected,
             COALESCE(SUM(GREATEST(i.amount - pay.paid, 0))
                        FILTER (WHERE i.status = 'issued'), 0)             AS outstanding,
             COUNT(*) FILTER (WHERE i.status = 'issued'
                                AND pay.paid < i.amount
                                AND i.due_date < CURRENT_DATE)::int        AS overdue_count
        FROM invoices i
        JOIN LATERAL (
          SELECT COALESCE(SUM(p.amount), 0) AS paid
            FROM invoice_payments p WHERE p.invoice_id = i.id
        ) pay ON TRUE
       GROUP BY i.organization_id
    `);
  }

  async createInvoice(input: {
    organizationId: number;
    invoiceNo: string;
    issueDate: string;
    dueDate: string;
    amount: string;
    status: string;
    description: string | null;
    notes: string | null;
  }) {
    const [created] = await this.db.insert(invoices).values(input).returning();
    return created;
  }

  async updateInvoice(
    id: number,
    input: Record<string, unknown>,
  ) {
    const [updated] = await this.db
      .update(invoices)
      .set({ ...input, updatedAt: sql`now()` })
      .where(eq(invoices.id, id))
      .returning();
    return updated ?? null;
  }

  async deleteInvoice(id: number): Promise<void> {
    await this.db.delete(invoices).where(eq(invoices.id, id));
  }

  async addPayment(input: {
    organizationId: number;
    invoiceId: number;
    amount: string;
    paidOn: string;
    method: string | null;
    reference: string | null;
    notes: string | null;
    recordedBy: number;
  }) {
    const [created] = await this.db
      .insert(invoicePayments)
      .values(input)
      .returning();
    return created;
  }

  async deletePayment(id: number, invoiceId: number): Promise<number> {
    const rows = await this.db
      .delete(invoicePayments)
      .where(
        and(eq(invoicePayments.id, id), eq(invoicePayments.invoiceId, invoiceId)),
      )
      .returning({ id: invoicePayments.id });
    return rows.length;
  }

  /** The next invoice number for a year. Unique index is what guarantees it. */
  async nextInvoiceNo(year: number): Promise<string> {
    const prefix = `EDS-${year}-`;
    const rows = await this.db.all<{ n: number | null }>(sql`
      SELECT MAX(NULLIF(regexp_replace(invoice_no, '^.*-', ''), '')::int) AS n
        FROM invoices WHERE invoice_no LIKE ${prefix + '%'}
    `);
    return `${prefix}${String(Number(rows[0]?.n ?? 0) + 1).padStart(4, '0')}`;
  }
}
