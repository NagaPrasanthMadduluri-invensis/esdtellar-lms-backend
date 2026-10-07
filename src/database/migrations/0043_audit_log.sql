-- 0043_audit_log.sql — a durable record of every mutating request.
--
-- WHY A SECOND TABLE, AND NOT activity_log
--
-- BACKEND_STRUCTURE.md 10.12 says it plainly, and this migration is that
-- sentence being acted on: "this is a product feature, not an audit trail --
-- the entries that are missing are precisely the ones whose write failed. If
-- a real audit trail is needed it is a different table with different
-- guarantees; do not quietly promote this one."
--
-- So activity_log keeps its job: 21 CURATED types, written by hand where a
-- service has something a human wants to read, best-effort, read as the
-- dashboard's Recent Activity panel. It must stay small and legible, and
-- pouring every CRUD request into it would bury "Course published" under ten
-- thousand rows nobody asked for.
--
-- audit_log is the other thing. It is written by ONE global interceptor, for
-- every POST / PATCH / PUT / DELETE that reaches the application, whether it
-- succeeded or not. Completeness is the point, and it is why this is an
-- interceptor rather than 200 remembered call sites: the codebase already
-- learned this with permissions (5.2.1 -- a permission with no guard behind
-- it is a screen that lies), and a hand-instrumented audit log has exactly
-- that failure, except the holes are invisible because the thing that is
-- missing is a row nobody wrote.
--
-- WHAT THIS DOES NOT PROMISE
--
-- The row is written AFTER the handler returns, not inside its transaction,
-- because an interceptor cannot enlist in a transaction the service has
-- already committed. So a crash in the gap between the commit and this
-- insert loses the entry. That is a narrower window than best-effort by a
-- long way -- the write is retried once and a failure is logged at `error`
-- rather than `warn` -- but it is not "transactionally guaranteed", and
-- anybody relying on this in a dispute should know which of those two
-- sentences is true.
--
-- NO organization_id NOT NULL
--
-- A platform admin acting outside any tenant, and a refused request from a
-- caller whose token did not verify, both have no organization. Storing 0 or
-- the platform org for those would be inventing a fact; NULL says what is
-- true, and the org-scoped read simply does not match them.
--
-- actor_name IS DENORMALISED AND FROZEN, the same reasoning as
-- activity_log.actor_name and email_outbox.to_email: joining to users at
-- read time renames history when somebody corrects their name, and returns
-- nothing at all once the account is deleted -- which is precisely the row
-- an audit log exists to still have.

CREATE TABLE IF NOT EXISTS audit_log (
  id                 bigserial PRIMARY KEY,

  organization_id    integer     REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id      integer     REFERENCES users(id)         ON DELETE SET NULL,
  actor_name         text        NOT NULL,
  actor_email        text,
  -- The PORTAL (admin | learner | trainer) and the RBAC role's label. Both,
  -- because the portal is what the filter groups by and the label is what a
  -- reader recognises -- a Manager rides the learner portal (rbac.md
  -- decision 2), so the portal alone would file their actions under
  -- "learner" and the label alone could not be filtered consistently.
  actor_portal       text,
  actor_role         text,

  -- Set only during a support session (10.17). Without it the audit log
  -- would attribute Edstellar's actions to the tenant's own owner admin,
  -- which is the one attribution this table must never get wrong.
  impersonator_name  text,

  method             text        NOT NULL,
  -- The matched ROUTE PATTERN (/api/admin/courses/:id), which is what groups;
  -- and the PATH actually requested, which is what identifies.
  route              text        NOT NULL,
  path               text        NOT NULL,
  -- create | update | delete, derived from the method once at write time so
  -- every reader agrees and nothing re-derives it.
  action             text        NOT NULL,
  entity             text,
  entity_id          integer,

  status_code        integer     NOT NULL,
  outcome            text        NOT NULL,
  error_message      text,

  -- The request body, REDACTED and capped. Never the raw body: it carries
  -- passwords on three routes and a token on two more, and an audit log that
  -- stores credentials is a bigger liability than no audit log at all.
  summary            jsonb,

  ip                 text,
  duration_ms        integer,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- The org feed, newest first. The one query the admin page always runs.
CREATE INDEX IF NOT EXISTS idx_audit_org_created
  ON audit_log (organization_id, created_at DESC);

-- The platform feed, which spans tenants and so cannot use the index above.
CREATE INDEX IF NOT EXISTS idx_audit_created
  ON audit_log (created_at DESC);

-- "What did this person do", the second question anybody asks.
CREATE INDEX IF NOT EXISTS idx_audit_actor
  ON audit_log (actor_user_id, created_at DESC);

-- "What happened to this course", the third.
CREATE INDEX IF NOT EXISTS idx_audit_entity
  ON audit_log (entity, entity_id, created_at DESC);

-- PARTIAL, over failures only -- the same instinct as
-- idx_notifications_unread. Failures are a small fraction of the table and
-- are what somebody scans for when they are investigating.
CREATE INDEX IF NOT EXISTS idx_audit_failures
  ON audit_log (organization_id, created_at DESC)
  WHERE outcome = 'failure';
