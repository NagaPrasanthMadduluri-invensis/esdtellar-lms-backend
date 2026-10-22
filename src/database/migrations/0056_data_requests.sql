-- Data-subject requests: a person asks to CORRECT or DELETE their personal
-- data (PDPA Access & Correction, and the deletion side of Retention). The
-- "My Data" self-service lets any authenticated user export a copy of
-- everything held about them and file one of these two requests.
--
-- Additive and idempotent (§6.2). One new table, nothing altered.
--
-- ─────────────────────────────────────────────────────────────────────────
-- A REQUEST IS LOGGED, NOT EXECUTED
-- ─────────────────────────────────────────────────────────────────────────
-- Nothing destructive happens when a subject clicks. Deleting learning
-- records reaches certificates, learning hours, org analytics and the audit
-- trail, so a deletion is a request an admin reviews and actions, not an
-- instant erasure. PDPA allows a reasonable process; it does not demand a
-- self-service hard delete. A correction is the same shape: the subject says
-- what is wrong, an admin fixes the record (most profile fields are already
-- self-editable, but learning records are not).
--
-- ─────────────────────────────────────────────────────────────────────────
-- ACTIVITY, NOT CONTENT
-- ─────────────────────────────────────────────────────────────────────────
-- A request belongs to exactly one tenant (the subject's org), so every read
-- is orgScope (§10.12). An admin of that org works the queue; there is no
-- cross-tenant view. ON DELETE CASCADE on both foreign keys: if the org or
-- the account goes, the request about it goes too.

CREATE TABLE IF NOT EXISTS data_requests (
  id              serial PRIMARY KEY,

  -- The subject's organization. orgScope, like every other activity table.
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- The data subject who filed it.
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- 'correction' | 'deletion' (src/common/data-requests.ts).
  type            text    NOT NULL,

  -- 'open' | 'in_progress' | 'resolved' | 'rejected'. Starts 'open'; only an
  -- admin moves it on.
  status          text    NOT NULL DEFAULT 'open',

  -- What the subject wants corrected, or why they want deletion. Capped at
  -- DESCRIPTION_MAX_LENGTH in the DTO.
  details         text,

  -- What the admin wrote back; visible to the subject.
  admin_note      text,

  -- The admin who actioned it, and when. SET NULL so removing an admin does
  -- not delete the request they handled.
  handled_by      integer REFERENCES users (id) ON DELETE SET NULL,
  handled_at      timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The admin queue: this org's requests, filtered by status, newest first.
CREATE INDEX IF NOT EXISTS idx_data_requests_org_status
  ON data_requests (organization_id, status, created_at DESC);

-- The subject's own list.
CREATE INDEX IF NOT EXISTS idx_data_requests_user
  ON data_requests (user_id, created_at DESC);
