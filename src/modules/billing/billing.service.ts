import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { invoiceState, outstanding } from '@/common/billing';

import { BillingRepository, type InvoiceRowWithPaid } from './billing.repository';
import type {
  CreateInvoiceDto,
  ListInvoicesDto,
  RecordPaymentDto,
  UpdateInvoiceDto,
} from './dto/invoice.dto';

@Injectable()
export class BillingService {
  constructor(private readonly repository: BillingRepository) {}

  /**
   * `numeric` comes back from pg as a string so float64 cannot silently round
   * it. Converted HERE, once, at the boundary — never with arithmetic on the
   * raw value, and never twice in two places that could disagree.
   */
  private shape(row: InvoiceRowWithPaid) {
    const amount = Number(row.amount);
    const paid = Number(row.paid);
    return {
      id: row.id,
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      invoice_no: row.invoice_no,
      issue_date: row.issue_date,
      due_date: row.due_date,
      amount,
      paid,
      outstanding: outstanding(amount, paid),
      currency: row.currency,
      status: row.status,
      /** Derived: paid / part_paid / overdue are never stored. */
      state: invoiceState({
        status: row.status,
        amount,
        paid,
        dueDate: row.due_date,
      }),
      payment_count: Number(row.payment_count),
      description: row.description,
      notes: row.notes,
      created_at: row.created_at,
    };
  }

  async list(query: ListInvoicesDto) {
    const [rows, totals] = await Promise.all([
      this.repository.listInvoices({
        organizationId: query.organization_id,
        status: query.status,
        limit: query.limit ?? 200,
        offset: query.offset ?? 0,
      }),
      this.repository.platformTotals(),
    ]);

    return {
      invoices: rows.map((r) => this.shape(r)),
      totals: {
        invoiced: Number(totals.invoiced),
        collected: Number(totals.collected),
        outstanding: Number(totals.outstanding),
        overdue_amount: Number(totals.overdue_amount),
        overdue_count: Number(totals.overdue_count),
        draft_count: Number(totals.draft_count),
      },
    };
  }

  async get(id: number) {
    const row = await this.repository.findInvoice(id);
    if (!row) throw new NotFoundException('Invoice not found');
    const payments = await this.repository.listPayments(id);
    return {
      invoice: this.shape(row),
      payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    };
  }

  async create(dto: CreateInvoiceDto) {
    if (dto.due_date < dto.issue_date) {
      throw new UnprocessableEntityException(
        'An invoice cannot fall due before it is issued.',
      );
    }

    const invoiceNo =
      dto.invoice_no ??
      (await this.repository.nextInvoiceNo(new Date(dto.issue_date).getFullYear()));

    const created = await this.repository.createInvoice({
      organizationId: dto.organization_id,
      invoiceNo,
      issueDate: dto.issue_date,
      dueDate: dto.due_date,
      // Stored as a string so the driver hands it to `numeric` untouched.
      amount: dto.amount.toFixed(2),
      status: dto.status ?? 'draft',
      description: dto.description ?? null,
      notes: dto.notes ?? null,
    });

    return this.get(created.id);
  }

  async update(id: number, dto: UpdateInvoiceDto) {
    const existing = await this.repository.findInvoice(id);
    if (!existing) throw new NotFoundException('Invoice not found');

    const issueDate = dto.issue_date ?? existing.issue_date;
    const dueDate = dto.due_date ?? existing.due_date;
    if (dueDate < issueDate) {
      throw new UnprocessableEntityException(
        'An invoice cannot fall due before it is issued.',
      );
    }

    /**
     * Reducing an invoice below what has already been paid is refused.
     *
     * It would make `outstanding` negative and the state "paid" for an amount
     * nobody agreed — the ledger would stop reconciling. Raise a credit note
     * instead, which is a different document.
     */
    if (dto.amount !== undefined && dto.amount < Number(existing.paid)) {
      throw new UnprocessableEntityException(
        `This invoice already has ${Number(existing.paid).toFixed(2)} paid against it. ` +
          'Lower the payments first, or raise a credit note.',
      );
    }

    const values: Record<string, unknown> = {};
    if (dto.issue_date !== undefined) values.issueDate = dto.issue_date;
    if (dto.due_date !== undefined) values.dueDate = dto.due_date;
    if (dto.amount !== undefined) values.amount = dto.amount.toFixed(2);
    if (dto.status !== undefined) values.status = dto.status;
    if (dto.description !== undefined) values.description = dto.description;
    if (dto.notes !== undefined) values.notes = dto.notes;

    await this.repository.updateInvoice(id, values);
    return this.get(id);
  }

  async remove(id: number) {
    const existing = await this.repository.findInvoice(id);
    if (!existing) throw new NotFoundException('Invoice not found');

    /**
     * An invoice with money against it is never deleted.
     *
     * Deleting it would take the payment rows with it (ON DELETE CASCADE) and
     * erase the record that somebody paid — which is the one thing a system of
     * record must not do. Void it instead: the invoice survives, stops being
     * owed, and the payment history stays readable.
     */
    if (Number(existing.paid) > 0) {
      throw new UnprocessableEntityException(
        'This invoice has payments recorded against it. Void it instead of ' +
          'deleting — deleting would erase the payment record.',
      );
    }

    await this.repository.deleteInvoice(id);
    return { message: 'Invoice deleted' };
  }

  async recordPayment(invoiceId: number, dto: RecordPaymentDto, adminId: number) {
    const invoice = await this.repository.findInvoice(invoiceId);
    if (!invoice) throw new NotFoundException('Invoice not found');

    if (invoice.status === 'void') {
      throw new UnprocessableEntityException(
        'This invoice is void. Payments cannot be recorded against it.',
      );
    }
    if (invoice.status === 'draft') {
      throw new UnprocessableEntityException(
        'This invoice is still a draft. Issue it before recording a payment.',
      );
    }

    // Overpayment is refused rather than silently accepted: it is almost
    // always a typo or a payment booked against the wrong invoice, and both
    // are cheaper to catch here than in a reconciliation later.
    const remaining = outstanding(Number(invoice.amount), Number(invoice.paid));
    if (dto.amount > remaining + 0.01) {
      throw new UnprocessableEntityException(
        `That is more than the ${remaining.toFixed(2)} outstanding on this invoice.`,
      );
    }

    await this.repository.addPayment({
      organizationId: invoice.organization_id,
      invoiceId,
      amount: dto.amount.toFixed(2),
      paidOn: dto.paid_on,
      method: dto.method ?? null,
      reference: dto.reference ?? null,
      notes: dto.notes ?? null,
      recordedBy: adminId,
    });

    return this.get(invoiceId);
  }

  async removePayment(invoiceId: number, paymentId: number) {
    const removed = await this.repository.deletePayment(paymentId, invoiceId);
    if (removed === 0) throw new NotFoundException('Payment not found');
    return this.get(invoiceId);
  }

  /** Per-tenant money, keyed by org id — for the overview's account table. */
  async totalsByOrganization() {
    const rows = await this.repository.totalsByOrganization();
    return new Map(
      rows.map((r) => [
        Number(r.organization_id),
        {
          invoiced: Number(r.invoiced),
          collected: Number(r.collected),
          outstanding: Number(r.outstanding),
          overdue_count: Number(r.overdue_count),
        },
      ]),
    );
  }
}
