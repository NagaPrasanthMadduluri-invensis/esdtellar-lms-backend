-- Tenant profile and contract terms on `organizations`.
--
-- Additive and idempotent (§6.2). Columns only, all nullable, no backfill.
--
-- The super-admin console needs to answer commercial questions an LMS row has
-- never carried: who is this tenant, who do we talk to, what did they sign,
-- and when does it run out. Until now `organizations` held id, name, slug,
-- logo, is_platform, is_active, created_at, perm_version — enough to scope
-- data, nothing about the account.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THESE LIVE ON `organizations` AND NOT IN A `tenant_accounts` TABLE
-- ─────────────────────────────────────────────────────────────────────────
--
-- One row per organization either way, joined on every platform read, and
-- never queried independently. A second table would buy a cleaner separation
-- of "tenancy" from "commercials" at the cost of a join on every screen that
-- shows both — which is all of them. Invoices DO get their own table (0027),
-- because there are many per tenant and they have their own lifecycle.
--
-- `contract_end` is the one to watch: the console warns on it, and the warning
-- is derived from the date rather than stored as a status, so nothing can
-- drift out of step with the calendar (§10.7 makes the same choice for a
-- session's `display_status`).

ALTER TABLE organizations
  -- Who they are. Both are filter dimensions in the tenant directory, so they
  -- are free text only because the platform team owns every value — there is
  -- no tenant-facing form that can invent one.
  ADD COLUMN IF NOT EXISTS industry        text,
  ADD COLUMN IF NOT EXISTS region          text,

  -- Who Edstellar talks to. Denormalised rather than pointed at a `users` row:
  -- the commercial contact is often not an LMS user at all, and when they are,
  -- deleting their account must not erase who signed the contract.
  ADD COLUMN IF NOT EXISTS contact_name    text,
  ADD COLUMN IF NOT EXISTS contact_email   text,
  ADD COLUMN IF NOT EXISTS contact_phone   text,

  -- What they signed.
  ADD COLUMN IF NOT EXISTS contract_start  date,
  ADD COLUMN IF NOT EXISTS contract_end    date,
  -- numeric, not float: this is money. A float would make two invoices sum to
  -- something that is not the contract value.
  ADD COLUMN IF NOT EXISTS contract_value  numeric(14, 2),
  ADD COLUMN IF NOT EXISTS plan            text,
  ADD COLUMN IF NOT EXISTS billing_cycle   text,

  -- Free text for the account manager. Never shown to the tenant.
  ADD COLUMN IF NOT EXISTS notes           text;

-- The directory sorts and filters on renewal date, and the overview asks
-- "whose contract ends soon" on every load.
CREATE INDEX IF NOT EXISTS idx_organizations_contract_end
  ON organizations (contract_end)
  WHERE contract_end IS NOT NULL;
