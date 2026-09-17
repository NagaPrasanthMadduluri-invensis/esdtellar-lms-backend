/**
 * Invoice vocabulary, and the two states that are DERIVED rather than stored.
 *
 * Tenth catalogue-as-code. Read `0027_billing.sql` first — the split between
 * what a human decides (`status`) and what the data says (paid, overdue) is
 * the whole design.
 */

/** What a human decided. Never `paid` or `overdue` — both are derived. */
export const INVOICE_STATUSES = ['draft', 'issued', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = [
  'bank_transfer',
  'cheque',
  'card',
  'other',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** What the UI shows, once the data is taken into account. */
export type InvoiceState =
  | 'draft'
  | 'void'
  | 'paid'
  | 'part_paid'
  | 'overdue'
  | 'issued';

/**
 * An invoice's real state.
 *
 * DERIVED from the payments against it and the calendar, never stored. A
 * stored `paid` flag would need something to reconcile it with the payment
 * rows, and a stored `overdue` would need a nightly job — if either drifted,
 * the flag would contradict the figures printed beside it.
 *
 * Order matters: void and draft short-circuit, because an invoice nobody
 * issued cannot be overdue and a cancelled one cannot be owed.
 */
export function invoiceState(input: {
  status: string;
  amount: number;
  paid: number;
  dueDate: string;
  today?: Date;
}): InvoiceState {
  if (input.status === 'void') return 'void';
  if (input.status === 'draft') return 'draft';

  // Tolerance of one paisa: `numeric` is exact, but an amount reconstructed
  // from several partial payments can land a rounding step away.
  if (input.paid >= input.amount - 0.01) return 'paid';

  const today = input.today ?? new Date();
  const due = new Date(`${String(input.dueDate).slice(0, 10)}T00:00:00Z`);
  const now = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  if (due.getTime() < now.getTime()) return 'overdue';

  return input.paid > 0 ? 'part_paid' : 'issued';
}

/** Outstanding on one invoice. Never negative — an overpayment is not a debt. */
export function outstanding(amount: number, paid: number): number {
  return Math.max(0, Math.round((amount - paid) * 100) / 100);
}
