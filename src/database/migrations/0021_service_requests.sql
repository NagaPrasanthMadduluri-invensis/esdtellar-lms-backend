-- Edstellar Services: an org admin asks Edstellar for a service, and the
-- request is tracked until somebody at Edstellar closes it.
--
-- Additive and idempotent (§6.2). One new table, nothing altered.
--
-- ─────────────────────────────────────────────────────────────────────────
-- WHY THE ANSWERS ARE ONE JSON COLUMN
-- ─────────────────────────────────────────────────────────────────────────
--
-- Each of the 42 services asks a different set of questions — a psychometric
-- request asks about norm groups and administration mode, a compliance
-- request asks which statute and how many sites. Fourteen question sets exist
-- today and they will change whenever Edstellar changes what it offers.
--
-- Modelling that relationally means either ~200 mostly-null columns, or an
-- answers table keyed by question id that nothing can join usefully because
-- the questions themselves are not rows. Both are worse than a document.
--
-- The trade is stated plainly: `answers` is NOT queryable as structured data.
-- Nothing filters or reports on it, and nothing should start to without first
-- promoting the field it needs to a real column. What IS queryable — who
-- asked, for what service, when, and where it has got to — is a column each,
-- because those are what the list screen and any future SLA report read.

CREATE TABLE IF NOT EXISTS service_requests (
  id              serial PRIMARY KEY,

  -- ACTIVITY, not content: a request belongs to exactly one tenant and is
  -- never shared, so every read is orgScope (§10.12). The reference mock
  -- shows Edstellar staff seeing every tenant's requests in one list; that is
  -- a PLATFORM view and would be a separate @PlatformAdmin route, never a
  -- widening of this one.
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- Human-facing reference, e.g. REQ-2026-0007. Generated server-side and
  -- unique within an organization: it is what an admin quotes in an email, so
  -- two requests must never wear the same one.
  ref_no          text    NOT NULL,

  -- One of SERVICE_NAMES in src/common/edstellar-services.ts. Text, not a
  -- foreign key: the catalogue is code (same argument as activity_log.type
  -- above), and a service Edstellar stops offering must not orphan the
  -- requests already filed against it.
  service         text    NOT NULL,

  -- The per-service questionnaire, as answered. See the note above.
  answers         jsonb   NOT NULL DEFAULT '{}'::jsonb,

  -- Lifted OUT of `answers` because the list screen shows them as columns and
  -- a JSON path in a WHERE clause is how a document column quietly becomes a
  -- schema. Both are free text from a fixed dropdown, so neither is a lookup.
  timeline        text,
  budget          text,

  -- One of REQUEST_STATUSES. Starts pending; only Edstellar moves it on.
  status          text    NOT NULL DEFAULT 'pending',
  -- What Edstellar wrote back. Visible to the requesting admin.
  response_note   text,

  -- Who asked. The user may later be deleted; the request still happened and
  -- still needs a name on it, so the name and email are DENORMALISED here
  -- rather than joined. Same reasoning as activity_log.actor_name.
  requested_by    integer REFERENCES users (id) ON DELETE SET NULL,
  contact_name    text    NOT NULL,
  contact_email   text    NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The only read this table has: one organization's requests, newest first.
-- Ordered index, so the list needs no sort step.
CREATE INDEX IF NOT EXISTS idx_service_requests_org_created
  ON service_requests (organization_id, created_at DESC);

-- The reference number is quoted by a human and must resolve to one row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_requests_org_ref
  ON service_requests (organization_id, ref_no);
