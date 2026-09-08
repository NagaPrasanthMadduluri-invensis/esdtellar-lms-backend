-- RBAC, phase 1 of 2 — the ADDITIVE half. Spec: specs/rbac.md §3.3, §3.4.
--
-- Everything here is safe to re-run on every boot, which is the contract for
-- this directory (BACKEND_STRUCTURE.md §6.2). The parts that are NOT additive
-- live in scripts/migrate-rbac.mjs and are a deliberate, reviewed run:
--
--   * seeding each organization's system roles
--   * backfilling users.role_id from users.role
--   * ADD CONSTRAINT for the composite FK  (no IF NOT EXISTS exists for it)
--   * ALTER COLUMN role_id SET NOT NULL    (fails while any row is NULL)
--
-- That is the same division the tenancy work used: 0007_organizations.sql was
-- additive and nullable, and migrate-tenancy.mjs did the backfill, the
-- constraints and the SET NOT NULLs under a human checkpoint.
--
-- WHAT THIS MODELS. An organization defines its own roles, so a role is a row
-- rather than a value in an enum. Two columns on that row are load-bearing and
-- are NOT permissions:
--
--   portal  which of the two portals a holder lands in. Two values only. A
--           manager is portal='learner' with one extra module, never a third
--           portal, so users.role survives untouched as the portal selector
--           and every existing @Roles() decorator keeps working.
--   scope   how wide that role's reads of PEOPLE are. Orthogonal to any
--           permission: view_employees says whether you may list employees,
--           scope says which ones. Resolved server-side from the actor's own
--           row, never from a request parameter.
--
-- WHY role_permissions HAS NO FOREIGN KEY on `permission`. There is no
-- permissions table on purpose: the catalogue is code (src/common/permissions.ts)
-- because a permission means something only when a guard checks it. The service
-- validates every key against that catalogue and returns 422 for an unknown
-- one. A permission later removed from the code leaves orphan rows here that
-- no guard reads -- the grant stops meaning anything, which is the safe
-- direction to fail.

CREATE TABLE IF NOT EXISTS roles (
  id              serial PRIMARY KEY,
  organization_id integer     NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  key             text        NOT NULL,
  label           text        NOT NULL,
  portal          text        NOT NULL CHECK (portal IN ('admin', 'learner')),
  scope           text        NOT NULL DEFAULT 'self' CHECK (scope IN ('org', 'department', 'self')),
  is_system       boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One role key per organization. Two orgs may both have 'manager' and they
  -- are different rows with different permissions -- that is decision 3.
  UNIQUE (organization_id, key),
  -- The composite target the users FK binds to (multi-tenancy.md §3.5). It is
  -- declared here rather than added later because this table is new, so the
  -- constraint arrives with it and stays idempotent.
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    integer NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission text    NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Nullable for now. migrate-rbac.mjs backfills it, adds the composite FK that
-- makes a cross-organization role assignment a DATABASE error, and only then
-- sets it NOT NULL.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role_id integer;

-- Bumped in the same transaction as any write to roles or role_permissions.
-- The JWT carries the value it was signed with and AuthGuard compares the two,
-- so a permission change signs that organization out and no other -- which is
-- how "a permission change forces a re-login" is delivered (decision 5).
-- DEFAULT 1 rather than 0 so that a token minted before this column existed,
-- carrying no claim at all, cannot accidentally compare equal to it.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS perm_version integer NOT NULL DEFAULT 1;

-- Listing an organization's roles, and counting holders per role.
CREATE INDEX IF NOT EXISTS idx_roles_org ON roles (organization_id);
CREATE INDEX IF NOT EXISTS idx_users_org_role_id ON users (organization_id, role_id);
