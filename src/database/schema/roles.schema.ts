import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

import { ROLE_PORTALS, ROLE_SCOPES } from '@/common/permissions';

/**
 * An organization's own role. Mirrors `roles` from
 * `database/migrations/0011_rbac_roles.sql` — spec `specs/rbac.md` §3.3.
 *
 * Roles are ROWS, not an enum: admin, learner, manager, trainer, or whatever
 * else an organization decides, and two organizations may both have a
 * `manager` that means different things (decision 3).
 *
 * Two columns here are not permissions and are easy to mistake for them:
 *
 * - `portal` — which of the two portals a holder lands in. `users.role` is
 *   written from this and stays the two-value portal selector, which is what
 *   leaves all 22 existing `@Roles()` decorators and the four client
 *   route-group layouts untouched. A manager is `portal: 'learner'` with one
 *   extra module, never a third portal (decision 2).
 * - `scope` — how wide this role's reads of PEOPLE are. Orthogonal to any
 *   permission: `view_employees` says whether you may list employees, `scope`
 *   says which ones (§3.5).
 *
 * The enum members come from `common/permissions.ts` rather than being spelled
 * again here, so the CHECK constraint in SQL, the Drizzle type and the guards
 * cannot drift apart.
 */
export const roles = pgTable(
  'roles',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    /** Stable identifier within the org, e.g. 'manager'. Unique per org. */
    key: text('key').notNull(),
    /** What this organization calls the role in its own UI. */
    label: text('label').notNull(),
    portal: text('portal', { enum: ROLE_PORTALS }).notNull(),
    scope: text('scope', { enum: ROLE_SCOPES }).notNull().default('self'),
    /**
     * Seeded with the organization (§3.7). Marks the three roles the lockout
     * guards hold on to; no guard treats a system role as privileged.
     */
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('roles_organization_id_key_key').on(table.organizationId, table.key),
    /**
     * The composite target `users (organization_id, role_id)` binds to, so
     * assigning a role from another organization is rejected by Postgres
     * rather than by a reviewer (multi-tenancy.md §3.5). Declared with the
     * table because the table is new; the FK on `users` that points at it is
     * added by `scripts/migrate-rbac.mjs`, after the backfill.
     */
    // Name is Postgres's own, generated from the inline UNIQUE in
    // 0011_rbac_roles.sql. Mirrored verbatim because §6.1 requires this
    // schema to match the live DDL exactly, and a cosmetic disagreement is
    // enough for `drizzle-kit push` to rewrite the table (§6.2). Naming it
    // in the SQL instead would make a fresh database disagree with this one.
    unique('roles_organization_id_id_key').on(table.organizationId, table.id),
    index('idx_roles_org').on(table.organizationId),
  ],
);

/**
 * Which permissions a role holds. The assignment is data; the CATALOGUE of
 * permissions is code (`common/permissions.ts`) — see that file for why.
 *
 * `permission` is deliberately plain `text` with no foreign key: there is no
 * permissions table to point at. The service validates each key against the
 * catalogue and returns 422 for an unknown one, and a permission later removed
 * from the code leaves orphan rows here that no guard reads.
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: integer('role_id').notNull(),
    permission: text('permission').notNull(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })],
);

export type RoleRow = typeof roles.$inferSelect;
export type NewRoleRow = typeof roles.$inferInsert;
export type RolePermissionRow = typeof rolePermissions.$inferSelect;
export type NewRolePermissionRow = typeof rolePermissions.$inferInsert;
