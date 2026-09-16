-- Job level on users, a normalised location, and the admin activity log.
--
-- All additive and idempotent (BACKEND_STRUCTURE.md §6.2): ADD COLUMN IF NOT
-- EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and two
-- UPDATEs that are no-ops once they have run. Safe on every boot.
--
-- WHY THESE THREE TOGETHER. They are the three things the admin Dashboard,
-- Analytics and Reports rebuild needs that the schema could not express:
--
--   users.job_level   Reports filters and compares by department, location,
--                     job level and job role. Three of those existed; this is
--                     the fourth. Without it the "Job Level" filter is a
--                     control with nothing behind it, which is the screen-that-
--                     lies failure §5.2.1 exists to prevent.
--
--   location cleanup  `location` already existed but held free text, so the
--                     same office was spelled two ways and three learners held
--                     NULL. A learner whose location matches no option in the
--                     filter dropdown is invisible to every location-filtered
--                     report — a silent omission, not an empty cell. The
--                     column stays TEXT; the closed list lives in
--                     src/common/workforce.ts and is enforced by the DTO.
--
--   activity_log      The Dashboard's Recent Activity panel. Nothing recorded
--                     admin actions anywhere, so there was no table to read
--                     and no way to add one later without losing the history
--                     in between.
--
-- WHAT activity_log IS AND IS NOT. It is a product feature — "what has been
-- happening in my organization" on the admin dashboard. It is NOT a security
-- audit trail: it is written best-effort (§8.4) so a logging failure can never
-- break the action being logged, which is the correct trade for a dashboard
-- panel and the wrong one for an audit record. If a real audit trail is needed
-- later it is a different table with different guarantees; do not quietly
-- promote this one, because the writes it is missing are the ones that failed.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Job level
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS job_level text;

-- Reports groups and filters on (organization_id, job_level); the org column
-- leads for the same reason it leads every other index here (spec §3.7).
CREATE INDEX IF NOT EXISTS idx_users_org_job_level
  ON users (organization_id, job_level);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Normalise the locations already stored
-- ─────────────────────────────────────────────────────────────────────────
--
-- Idempotent because it matches on the legacy spelling: once rewritten there
-- is nothing left to match. NULLs are deliberately NOT filled here — this
-- migration cannot invent where somebody works. `scripts/seed-history.mjs`
-- assigns them for the demo organization, and for a real deployment an admin
-- fills them in from the user form, where the field is now a dropdown.

UPDATE users SET location = 'Bangalore' WHERE location IN ('Banagalore', 'Bengaluru');
UPDATE users SET location = 'Delhi NCR' WHERE location = 'Delhi';

CREATE INDEX IF NOT EXISTS idx_users_org_location
  ON users (organization_id, location);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Activity log
-- ─────────────────────────────────────────────────────────────────────────
--
-- `actor_user_id` is ON DELETE SET NULL, not CASCADE: deleting an admin must
-- not erase the record of what they did while they were here. The row keeps
-- `actor_name` as a denormalised copy for exactly the same reason — it is what
-- the panel renders, and it has to survive the account it names.
--
-- `subject_type` / `subject_id` are a loose reference, not a foreign key. The
-- subject may be a course that has since been deleted, and the entry saying it
-- was uploaded is still true and still worth showing.

CREATE TABLE IF NOT EXISTS activity_log (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL,
  -- One of the ACTIVITY_TYPES in src/common/activity.ts. Text, not an enum:
  -- the catalogue is code (same argument as permissions.ts), and adding a type
  -- must not need a migration.
  type            text    NOT NULL,
  -- Rendered as the entry's heading and body respectively.
  title           text    NOT NULL,
  detail          text,
  actor_user_id   integer REFERENCES users (id) ON DELETE SET NULL,
  actor_name      text    NOT NULL,
  subject_type    text,
  subject_id      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The only read this table has: newest first, within one organization.
-- (organization_id, created_at DESC) serves it as an index-ordered scan with
-- no sort step, which matters because the dashboard asks for it on every load.
CREATE INDEX IF NOT EXISTS idx_activity_log_org_created
  ON activity_log (organization_id, created_at DESC);
