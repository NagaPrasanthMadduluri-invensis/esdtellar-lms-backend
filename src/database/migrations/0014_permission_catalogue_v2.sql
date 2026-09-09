-- Keeps existing admin roles whole when the permission catalogue changed.
-- Spec: specs/rbac.md §3.2, §3.9.
--
-- WHY THIS EXISTS. Putting @Permissions() on the remaining routes turned 14
-- catalogue entries from decoration into enforcement, and in the same change
-- two capabilities that had NO permission at all got one:
--
--     manage_certificates   issue / revoke / reinstate a certificate
--     manage_sessions       create / edit / delete a training session
--
-- Every organization's `admin` role was seeded with "all permissions", but
-- that meant all permissions AS THEY WERE THEN. Without this migration those
-- roles hold 19 rows, neither of the two new keys is among them, and the
-- moment the guards go live every existing org admin silently loses the
-- ability to create a session or issue a certificate — work they could do the
-- day before. That is not a permission change anyone chose.
--
-- WHY IT IS SAFE TO DO AUTOMATICALLY, when §6.2 says a backfill is normally a
-- human checkpoint:
--
--   * it is restricted to `is_system = true AND key = 'admin'` — the role that
--     is seeded with the whole catalogue by definition (§3.7). It cannot touch
--     a custom role, and it cannot touch `manager`, `learner` or a `trainer`,
--     so it cannot widen a role anyone deliberately narrowed;
--   * it RESTORES a capability rather than granting a new one. The routes it
--     re-opens were open to these roles before this deploy;
--   * ON CONFLICT DO NOTHING makes it a no-op on every boot after the first,
--     and a no-op for any organization created after the catalogue change.
--
-- An organization that has deliberately unticked something on its OWN admin
-- role is unaffected in that respect: this only ever adds the two brand-new
-- keys, which nobody can have unticked because they did not exist.
-- ONE statement, with the version bump chained to the insert in a CTE. That is
-- not stylistic. Adding a row to `role_permissions` does not change the tokens
-- already in circulation: an admin's JWT carries the 19 permissions it was
-- signed with, so they would keep getting 403 from the session and certificate
-- routes until it expired, up to seven days later. Bumping `perm_version` is
-- what makes AuthGuard reject the stale token and reissue it on the next sign
-- in — decision 5, applied to a catalogue change rather than an admin's edit.
--
-- The bump has to be CONDITIONAL on the insert having actually added something,
-- or this file would sign every organization out on every boot. `added` is
-- empty from the second run onwards, so the UPDATE matches no rows and the
-- whole migration becomes the no-op the contract in §6.2 requires.
WITH added AS (
  INSERT INTO role_permissions (role_id, permission)
  SELECT r.id, p.permission
    FROM roles r
   CROSS JOIN (VALUES ('manage_certificates'), ('manage_sessions')) AS p(permission)
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

-- `manage_departments` rows are deliberately LEFT IN PLACE. The catalogue no
-- longer lists it (there is no department CRUD to guard — specs/rbac.md §8.2),
-- so `filterKnownPermissions` drops it on the way out of the database and no
-- guard reads it: an orphan grant that means nothing, which is the documented
-- safe direction to fail. Deleting rows to tidy the display would be a
-- destructive migration buying nothing, and it would throw away the record of
-- what an organization had ticked if that table ever comes back.
