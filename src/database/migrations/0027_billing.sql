-- Invoices and payments. The LMS is the system of record for both.
--
-- Additive and idempotent (§6.2). Two new tables, nothing existing altered.
--
-- ═════════════════════════════════════════════════════════════════════════
-- MONEY IS `numeric`, NEVER `double precision`
-- ═════════════════════════════════════════════════════════════════════════
--
-- A float cannot represent 0.1 exactly, so a column of them does not sum to
-- what a human adds up — and this is the table somebody reconciles against a
-- bank statement. `numeric(14,2)` is exact decimal: 14 digits total, 2 after
-- the point, which tops out at 999,999,999,999.99 and is ample for contracts
-- quoted in crores.
--
-- Note `pg` returns `numeric` as a STRING to avoid silently losing precision
-- in JavaScript's float64. Every read here converts once, deliberately, at the
-- service boundary — never with arithmetic on the raw value.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY PAYMENTS ARE THEIR OWN TABLE AND `paid` IS NOT A FLAG
-- ═════════════════════════════════════════════════════════════════════════
--
-- An invoice is not simply paid or unpaid: it is part-paid, paid in two
-- instalments, paid against a reference somebody needs to find later. A
-- boolean would answer none of that, and the first partial payment would
-- force a schema change.
--
-- So `invoice_payments` records what actually arrived, and what an invoice is
-- "worth" is SUM(payments) against its amount. `invoices.status` stores only
-- what a human decided — draft, issued, void — while paid and overdue are
-- DERIVED (see `common/billing.ts`):
--
--   paid     = SUM(payments) >= amount
--   overdue  = not paid AND due_date < today AND status = 'issued'
--
-- Storing either would need something to run at midnight, and if it ever
-- failed the stored value would contradict the dates printed beside it. Same
-- choice §10.7 makes for a session's `display_status`.

CREATE TABLE IF NOT EXISTS invoices (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- Human-facing and quoted in correspondence, so it must resolve to one row.
  invoice_no      text    NOT NULL,

  issue_date      date    NOT NULL,
  due_date        date    NOT NULL,

  -- Exact decimal. See the header.
  amount          numeric(14, 2) NOT NULL,
  currency        text    NOT NULL DEFAULT 'INR',

  -- draft | issued | void. NOT paid/overdue — both of those are derived.
  status          text    NOT NULL DEFAULT 'draft',

  description     text,
  notes           text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The overview asks "what is outstanding across every tenant" on every load,
-- and a tenant's own page asks for its invoices newest first.
CREATE INDEX IF NOT EXISTS idx_invoices_org_issued
  ON invoices (organization_id, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_due
  ON invoices (due_date) WHERE status = 'issued';

-- An invoice number must resolve to exactly one invoice, platform-wide —
-- unlike a tenant's service-request ref, which is only unique within its org.
-- These go out to customers and into a ledger; two invoices sharing a number
-- is a reconciliation problem, not a display one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_no
  ON invoices (invoice_no);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- Deleting an invoice takes its payments: a payment against nothing is not
  -- a record anybody can act on, and voiding is what you do to a live invoice.
  invoice_id      integer NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,

  amount          numeric(14, 2) NOT NULL,
  paid_on         date    NOT NULL,
  -- bank_transfer | cheque | card | other. Text, not an enum: payment rails
  -- change more often than a migration is worth.
  method          text,
  -- The bank/UTR reference somebody will search for. Free text on purpose.
  reference       text,
  notes           text,

  -- Who recorded it. ON DELETE SET NULL — the payment still happened.
  recorded_by     integer REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
  ON invoice_payments (invoice_id, paid_on);
CREATE INDEX IF NOT EXISTS idx_invoice_payments_org
  ON invoice_payments (organization_id, paid_on DESC);
