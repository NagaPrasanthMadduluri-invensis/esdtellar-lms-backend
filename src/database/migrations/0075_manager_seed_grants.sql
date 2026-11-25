-- Extra admin permissions on learner-portal roles now take effect
-- (BACKEND_STRUCTURE 10.65). The system Manager role was SEEDED with
-- view_dashboard and view_reports, which until now granted nothing (they
-- guard admin routes a learner-portal account could not reach). Left in
-- place they would silently hand every manager the admin Dashboard, Analytics
-- and Reports. Nobody chose them, so they are removed: managers keep exactly
-- what they had (My Team). An admin can tick them again on purpose.
-- Only the seeded system role keyed manager; custom roles are untouched.
-- Idempotent: a second run deletes nothing and bumps nobody.

UPDATE users SET perm_version = perm_version + 1
WHERE role_id IN (
  SELECT rp.role_id FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
  WHERE r.key = 'manager' AND r.is_system = true AND r.portal = 'learner'
    AND rp.permission IN ('view_dashboard', 'view_reports')
);

DELETE FROM role_permissions
WHERE permission IN ('view_dashboard', 'view_reports')
  AND role_id IN (
    SELECT id FROM roles WHERE key = 'manager' AND is_system = true AND portal = 'learner'
  );
