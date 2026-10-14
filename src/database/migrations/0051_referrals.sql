-- Referrals: an organization admin refers another COMPANY to become a Spectra
-- LMS customer. The referrer earns a tiered discount once a referral converts
-- to an active customer, and the prospect is sent an invitation email on
-- Edstellar's brand.
--
-- Additive and idempotent (§6.2). One new table, nothing altered.
--
-- This is the Edstellar Services shape (0021) applied a second time: a tenant
-- files a row, a @PlatformAdmin queue manages it cross-tenant, and only the
-- platform side moves the status past its initial value. Read 0021's header
-- for the reasoning that is shared; what differs here is below.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ACTIVITY, NOT CONTENT
-- ─────────────────────────────────────────────────────────────────────────
-- A referral belongs to exactly one tenant (the REFERRER) and is never shared,
-- so every tenant read is orgScope (§10.12). Edstellar staff see every
-- tenant's referrals through a separate @PlatformAdmin route, never a widening
-- of the org one.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE REWARD TIER IS DERIVED, NEVER STORED
-- ─────────────────────────────────────────────────────────────────────────
-- 2 converted referrals earn 15% off, 3 earn 25%. That is COUNT(*) WHERE
-- status = 'converted' per org, computed at read time like a contract's or an
-- invoice's state (§10.17) — not a column that a midnight job has to keep in
-- step with the rows it summarises. The discount is shown as earned; applying
-- it to billing is a deliberate platform-admin action, not an automation.

CREATE TABLE IF NOT EXISTS referrals (
  id                        serial PRIMARY KEY,

  -- The REFERRER's organization. orgScope, ON DELETE CASCADE like every other
  -- activity table: a tenant's referrals go when the tenant does.
  organization_id           integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- Human-facing reference, e.g. REF-2026-0007. Generated server-side and
  -- unique within the referrer's organization.
  ref_no                    text    NOT NULL,

  -- Who filed it. May later be deleted; the referral still happened and still
  -- needs a name on it, so the name and email are DENORMALISED below rather
  -- than joined. Same reasoning as service_requests.contact_name.
  referred_by               integer REFERENCES users (id) ON DELETE SET NULL,
  referrer_name             text    NOT NULL,
  referrer_email            text    NOT NULL,

  -- The prospect: the company being referred and the person to contact.
  company_name              text    NOT NULL,
  contact_name              text    NOT NULL,
  contact_email             text    NOT NULL,
  contact_phone             text,
  industry                  text,
  country                   text,
  team_size                 text,                 -- free text, e.g. "50-100"
  notes                     text,                 -- capped at DESCRIPTION_MAX_LENGTH in the DTO

  -- One of REFERRAL_STATUSES (src/common/referrals.ts). Starts 'invited' (the
  -- invite email fires on submit); only Edstellar moves it on.
  status                    text    NOT NULL DEFAULT 'invited',
  -- What Edstellar wrote back; visible to the referring admin.
  platform_note             text,

  -- Set when the referral converts. The referrer sees "Now a Spectra customer"
  -- and nothing of the converted org's internal data. ON DELETE SET NULL so
  -- removing a tenant does not delete the referral that won it.
  converted_organization_id integer REFERENCES organizations (id) ON DELETE SET NULL,
  converted_at              timestamptz,
  invite_email_at           timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

-- The tenant's only read: one organization's referrals, newest first.
CREATE INDEX IF NOT EXISTS idx_referrals_org_created
  ON referrals (organization_id, created_at DESC);

-- The reference number is quoted by a human and must resolve to one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_org_ref
  ON referrals (organization_id, ref_no);

-- The platform queue filters by status across every tenant.
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status);

-- First-touch attribution: a prospect email can be referred once, globally.
-- A second organization referring the same address is refused with a 409
-- rather than two orgs both claiming the same lead. (Relaxable later to
-- per-org or to not-yet-declined if the business wants it.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_contact_email
  ON referrals (LOWER(contact_email));
