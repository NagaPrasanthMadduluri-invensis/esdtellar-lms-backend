-- A phone number on a user, and the permission that lets a tenant admin edit
-- their own organization.
--
-- Additive and idempotent (§6.2).
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY `phone` AND NOT `manager`
-- ═════════════════════════════════════════════════════════════════════════
--
-- The reference profile dialog shows both. Only one of them is being added.
--
-- A phone number is a fact about the person that nothing else in the system
-- has to interpret: it is stored, displayed and edited by its owner, and it is
-- immediately useful to an admin looking at a learner's record.
--
-- A manager is not that. There is no reporting line anywhere in this product —
-- `specs/rbac.md` gives a Manager a DEPARTMENT scope, not a set of direct
-- reports, and Team Learning reads the department, not a hierarchy. A
-- `manager_id` column would therefore render as "—" on every row forever and
-- change nothing, which is the empty-column failure §10.12 records for the
-- three report types that were left out. When a real reporting line is needed
-- it will arrive with something that reads it.
--
-- Free text, not validated. International formats, extensions and "ask
-- reception" are all legitimate, and a regex here would reject a real number
-- while catching no mistake that matters.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone text;

-- ═════════════════════════════════════════════════════════════════════════
-- `manage_organization`
-- ═════════════════════════════════════════════════════════════════════════
--
-- Same shape as 0016_journeys_permission.sql and 0022_services_permission.sql,
-- for the same reason and with the same guardrails — read 0022's header for
-- the full argument. In short: every org's `admin` role was seeded with "all
-- permissions as they were then", so a new catalogue key has to be granted or
-- the guard that checks it 403s a module nobody decided to withhold.
--
-- It is a permission of its own rather than being folded into `manage_users`
-- because the two are different jobs at different levels: one adds a person,
-- the other renames the company. An organization that defines a restricted
-- admin role — a coordinator, an auditor — should be able to hand out the
-- first without the second.
--
-- What it does NOT unlock is the point: the contract, the plan, the billing
-- cycle and the seat limit stay `@PlatformAdmin()`-only. A tenant editing its
-- own commercial terms, or raising its own seat cap, would make both
-- meaningless.
WITH added AS (
  INSERT INTO role_permissions (role_id, permission)
  SELECT r.id, 'manage_organization'
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
