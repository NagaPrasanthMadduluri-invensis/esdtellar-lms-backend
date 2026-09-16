-- Keeps existing admin roles whole now that the permission catalogue has
-- gained `request_services` (BACKEND_STRUCTURE.md §5.2.1). This is
-- 0016_journeys_permission.sql applied a second time, for the same reason and
-- with the same guardrails — read that file's header for the full argument.
--
-- In short: every organization's `admin` role was seeded with "all
-- permissions", meaning all permissions AS THEY WERE THEN. Adding a key to
-- `src/common/permissions.ts` without this leaves every existing admin holding
-- what they had before, and the moment `ServicesController`'s guard checks the
-- new key they get 403 for a module nobody decided to withhold.
--
-- Safe to run automatically, for the three reasons 0016 lists:
--
--   * restricted to `is_system = true AND key = 'admin'` — the role seeded
--     with the whole catalogue by definition. It cannot touch a custom role,
--     nor `manager`, `learner` or `trainer`, so it cannot widen a role anyone
--     deliberately narrowed,
--   * it grants a capability that did not exist anywhere before this deploy,
--     so there is no prior admin decision it could override,
--   * ON CONFLICT DO NOTHING makes it a no-op on every boot after the first.
--
-- The `perm_version` bump is chained to the insert in a CTE and is CONDITIONAL
-- on a row actually having been added. A permission row does not change a JWT
-- already in circulation, so without the bump an admin keeps getting 403 until
-- their token expires; and without the condition this file would sign every
-- organization out on every boot.
WITH added AS (
  INSERT INTO role_permissions (role_id, permission)
  SELECT r.id, 'request_services'
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
