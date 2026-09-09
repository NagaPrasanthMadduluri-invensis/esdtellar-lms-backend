-- A per-USER token version, so a change that affects one person signs out one
-- person. Spec: specs/rbac.md §3.6.
--
-- WHY. `organizations.perm_version` (0011) is the right instrument for editing
-- a ROLE: everyone holding it is affected, so signing the organization out is
-- proportionate. It is the wrong instrument for moving ONE user onto a
-- different role, which is routine administration — adding a single employee
-- would have signed out every other person in the organization.
--
-- With both, the two cases separate cleanly:
--
--   role's permissions edited  -> bump organizations.perm_version -> org re-logs in
--   one user moved to a role   -> bump users.perm_version         -> that user only
--
-- AuthGuard compares BOTH claims, so neither can be bypassed by the other. The
-- default of 1 matches the organization column for the same reason: a token
-- minted before this claim existed carries undefined, which can never compare
-- equal to it.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS perm_version integer NOT NULL DEFAULT 1;
