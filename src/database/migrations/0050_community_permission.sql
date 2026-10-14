-- 0050_community_permission.sql
--
-- Grants the new `moderate_community` permission to existing SYSTEM admin roles,
-- mirroring 0016_journeys_permission.sql. Learner participation needs no
-- permission (it is not an org-granted capability); this one gates only the
-- admin moderation deletes.
--
-- Only organizations whose admin role actually gained the permission have
-- perm_version bumped, which signs those admins out once (BACKEND_STRUCTURE.md
-- 5.2.1 / 10.17). ON CONFLICT makes a re-run a no-op.

WITH added AS (
  INSERT INTO role_permissions (role_id, permission)
  SELECT r.id, 'moderate_community'
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
