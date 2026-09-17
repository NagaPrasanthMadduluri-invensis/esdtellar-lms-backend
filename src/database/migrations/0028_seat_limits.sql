-- Seat limits, and the requests a tenant raises to change one.
--
-- Additive and idempotent (§6.2). One column, one table.
--
-- ═════════════════════════════════════════════════════════════════════════
-- A SEAT IS AN ACTIVE LEARNER, AND THE LIMIT IS ENFORCED
-- ═════════════════════════════════════════════════════════════════════════
--
-- `seat_limit` NULL means unlimited, which is what every existing tenant gets
-- — no backfill, and nobody is suddenly capped by a deploy.
--
-- What counts against it is `users` with `role = 'learner'` AND `is_active =
-- 1`, in that organization. Deliberately NOT every user row:
--
--   * a deactivated learner has no access and costs the tenant nothing, so
--     counting them would charge for people who cannot log in — and would
--     make "deactivate someone to free a seat" not work, which is the obvious
--     thing an admin at the cap will try,
--   * admins, managers and trainers are not seats. An organization should not
--     have to choose between an extra trainer and an extra learner.
--
-- **The limit is checked when a learner is created or reactivated.** A limit
-- that is displayed but not enforced is decoration, and worse than none: it
-- tells an admin they are capped while letting them past it.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS seat_limit integer;

-- ─────────────────────────────────────────────────────────────────────────
-- SEAT REQUESTS
-- ─────────────────────────────────────────────────────────────────────────
--
-- Its own table rather than a row in `service_requests`. The shapes look
-- alike — a tenant asks, the platform answers — but they are different
-- things:
--
--   * a service request is routed to a SALES conversation and carries a
--     free-form questionnaire nothing queries,
--   * a seat request is an ACCOUNT change with exactly one number in it, and
--     approving it writes `organizations.seat_limit`. The super admin needs
--     "requested 50" as a column to act on, not a key inside a JSON blob.
--
-- Folding it into `service_requests` would mean a reserved service name that
-- is not in the catalogue, and a jsonb read on the one field that matters.

CREATE TABLE IF NOT EXISTS seat_requests (
  id               serial PRIMARY KEY,
  organization_id  integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- What they are asking for, and what the picture looked like when they
  -- asked. Both stored: approving a month-old request should show the super
  -- admin what the tenant saw at the time, not just what is true now.
  requested_seats  integer NOT NULL,
  current_limit    integer,
  current_used     integer NOT NULL,

  reason           text,

  -- pending | approved | declined. Only the platform moves it.
  status           text    NOT NULL DEFAULT 'pending',
  -- What Edstellar wrote back; the tenant's admin reads this.
  response_note    text,
  -- What was actually granted, which may differ from what was asked.
  approved_seats   integer,

  requested_by     integer REFERENCES users (id) ON DELETE SET NULL,
  contact_name     text    NOT NULL,
  contact_email    text    NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seat_requests_org_created
  ON seat_requests (organization_id, created_at DESC);

-- The platform queue reads pending first, across every tenant.
CREATE INDEX IF NOT EXISTS idx_seat_requests_status
  ON seat_requests (status, created_at DESC);

-- One open request per tenant. A second would let an admin queue three
-- increases and leave the platform guessing which one is current.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_requests_one_open
  ON seat_requests (organization_id)
  WHERE status = 'pending';
