-- Keeps existing admin roles whole when the permission catalogue gained
-- `manage_journeys`. Spec: specs/learning-journeys.md §5, §6.15 --
-- BACKEND_STRUCTURE.md §5.2.1, mirroring 0014_permission_catalogue_v2.sql.
--
-- WHY THIS EXISTS. Every organization's `admin` role was seeded with "all
-- permissions", but that meant all permissions AS THEY WERE THEN. Adding
-- `manage_journeys` to the catalogue (src/common/permissions.ts) without this
-- migration leaves every existing org admin's role holding whatever it had
-- before, and the moment a guard checks the new key on a journey write route,
-- every existing admin gets 403 for work nobody decided to take away from
-- them. That is not a permission change anyone chose.
--
-- WHY IT IS SAFE TO DO AUTOMATICALLY, when a backfill is normally a human
-- checkpoint (BACKEND_STRUCTURE.md §6.2):
--
--   * it is restricted to `is_system = true AND key = 'admin'` -- the role
--     that is seeded with the whole catalogue by definition. It cannot touch
--     a custom role, and it cannot touch `manager`, `learner` or `trainer`,
--     so it cannot widen a role anyone deliberately narrowed,
--   * it grants a capability that did not exist anywhere before this deploy,
--     so there is no prior admin decision it could be overriding,
--   * ON CONFLICT DO NOTHING makes it a no-op on every boot after the first,
--     and a no-op for any organization created after this catalogue change.
--
-- ONE statement, with the version bump chained to the insert in a CTE, for the
-- same reason 0014 does it that way: adding a row to `role_permissions` does
-- not change a token already in circulation. An admin's JWT carries the
-- permissions it was signed with, so without the bump they would keep getting
-- 403 from journey write routes until the token expires, up to
-- AUTH_TOKEN_DAYS later. Bumping `perm_version` makes AuthGuard reject the
-- stale token and reissue it on the next sign-in (rbac.md decision 5).
--
-- The bump is CONDITIONAL on the insert having actually added a row, or this
-- file would sign every organization out on every boot. `added` is empty from
-- the second run onward, so the UPDATE matches no rows and the whole
-- migration is the no-op the contract in §6.2 requires.
WITH added AS (
  INSERT INTO role_permissions (role_id, permission)
  SELECT r.id, 'manage_journeys'
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
