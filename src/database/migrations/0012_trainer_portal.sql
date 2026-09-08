-- The trainer portal. Spec: specs/rbac.md decision 6 and §3.6.1.
--
-- Two independent changes, both additive and both re-runnable.
--
-- 1. A THIRD PORTAL. roles.portal was created with a two-value CHECK in
--    0011_rbac_roles.sql. A trainer is neither an admin nor a learner: running
--    sessions has no home in either portal, and the owner was explicit that a
--    trainer is not an admin. Note there is nothing to change on users.role --
--    it is plain TEXT with no CHECK, so the third value cost no column change,
--    only the Drizzle enum and the UserRole type.
--
--    DROP IF EXISTS followed by ADD is what makes widening a CHECK idempotent:
--    ADD CONSTRAINT alone has no IF NOT EXISTS and would fail on the second
--    boot. Re-validating a CHECK over a handful of role rows on each boot is
--    not worth avoiding.
--
-- 2. A SESSION FINALLY KNOWS WHICH USER ITS TRAINER IS. sessions.trainer is
--    TEXT NOT NULL -- a name typed into a box -- so "the sessions assigned to
--    me" was not expressible at all. That is the blocker this column removes.
--
--    Nullable and additive on purpose. Every existing session keeps its
--    trainer text, which stays the display name and the value the admin form
--    has always shown. A session with no trainer_user_id belongs to no
--    trainer's portal; it is unassigned, not broken. The admin session form
--    gains a trainer picker and writes both columns from then on.
--
--    The composite FK (organization_id, trainer_user_id) -> users is NOT here.
--    ADD CONSTRAINT is not re-runnable, so it belongs with the other
--    constraints in scripts/migrate-rbac.mjs, under the same human checkpoint
--    the tenancy migration used.

ALTER TABLE roles
  DROP CONSTRAINT IF EXISTS roles_portal_check;

ALTER TABLE roles
  ADD CONSTRAINT roles_portal_check CHECK (portal IN ('admin', 'learner', 'trainer'));

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS trainer_user_id integer;

-- Every trainer-portal read starts "my sessions in my org", so the org column
-- leads (BACKEND_STRUCTURE.md §7.4).
CREATE INDEX IF NOT EXISTS idx_sessions_trainer_user
  ON sessions (organization_id, trainer_user_id);
