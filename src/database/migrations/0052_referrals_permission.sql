-- Keeps existing admin roles whole now that the permission catalogue has
-- gained `manage_referrals` (BACKEND_STRUCTURE.md §5.2.1). This is
-- 0022_services_permission.sql applied a third time, for the same reason and
-- with the same guardrails — read that file's header for the full argument.
--
-- In short: every organization's `admin` role was seeded with "all
-- permissions", meaning all permissions AS THEY WERE THEN. Adding a key to
-- `src/common/permissions.ts` without this leaves every existing admin holding
-- what they had before, and the moment the referrals controller's guard checks
-- the new key they get 403 for a module nobody decided to withhold.
--
-- Safe to run automatically, for the three reasons 0016/0022 list:
--
--   * restricted to `is_system = true AND key = 'admin'` — the role seeded
--     with the whole catalogue by definition. It cannot touch a custom role,
--     nor `manager`, `learner` or `trainer`,
--   * it grants a capability that did not exist anywhere before this deploy,
--     so there is no prior admin decision it could override,
--   * ON CONFLICT DO NOTHING makes it a no-op on every boot after the first.
--
-- The `perm_version` bump is chained to the insert in a CTE and is CONDITIONAL
-- on a row actually having been added, so this file does not sign every
-- organization out on every boot, but does invalidate the stale JWTs that
-- would otherwise 403 against the new guard until they expire.
WITH added AS (
  INSERT INTO role_permissions (role_id, permission)
  SELECT r.id, 'manage_referrals'
    FROM roles r
   WHERE r.key = 'admin'
     AND r.is_system = true
  ON CONFLICT (role_id, permission) DO NOTHING
  RETURNING role_id
)
UPDATE organizations o
   SET perm_version = o.perm_version + 1
 WHERE o.id IN (
   SELECT r.organization_id FROM roles r WHERE r.id IN (SELECT role_id FROM added)
 );
