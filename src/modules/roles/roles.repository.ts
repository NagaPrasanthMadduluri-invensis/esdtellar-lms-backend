import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { RolePortal } from '@/common/permissions';
import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

export interface RoleListRow {
  id: number;
  key: string;
  label: string;
  /**
   * Typed as the closed union rather than `string`: `roles_portal_check` in
   * the database restricts the column to exactly these three values, so
   * anything else cannot be stored, and the Drizzle `users.role` column is
   * the same union — a plain `string` here would not assign to it.
   */
  portal: RolePortal;
  scope: string;
  is_system: boolean;
  users: number;
  permissions: string[];
}

/**
 * Every query for `roles` and `role_permissions` — `specs/rbac.md` §3.3.
 *
 * All of them are org-scoped through `roles.organization_id`. A role belongs to
 * exactly one organization, so there is no content-scope variant here: unlike a
 * course, a role is never shared from the platform org.
 */
@Injectable()
export class RolesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * The organization's roles, with holder counts and their permissions.
   *
   * One query: holders come from a grouped aggregate and permissions from a
   * correlated `array_agg`, rather than a count and a fetch per role
   * (`BACKEND_STRUCTURE.md` §7.1).
   */
  async list(scope: OrgScope): Promise<RoleListRow[]> {
    return this.db.all<RoleListRow>(sql`
      SELECT r.id, r.key, r.label, r.portal, r.scope, r.is_system,
             COUNT(u.id) AS users,
             COALESCE(
               (SELECT array_agg(rp.permission ORDER BY rp.permission)
                  FROM role_permissions rp WHERE rp.role_id = r.id),
               ARRAY[]::text[]
             ) AS permissions
      FROM roles r
      LEFT JOIN users u ON u.role_id = r.id AND u.is_active = 1
      WHERE ${orgScope('r', scope)}
      GROUP BY r.id, r.key, r.label, r.portal, r.scope, r.is_system
      ORDER BY r.is_system DESC, r.key
    `);
  }

  async findById(scope: OrgScope, roleId: number) {
    const rows = await this.db.all<{
      id: number;
      key: string;
      label: string;
      portal: RolePortal;
      scope: string;
      is_system: boolean;
      users: number;
    }>(sql`
      SELECT r.id, r.key, r.label, r.portal, r.scope, r.is_system,
             (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users
      FROM roles r
      WHERE r.id = ${roleId} AND ${orgScope('r', scope)}
    `);
    return rows[0] ?? null;
  }

  /**
   * One role by its key within the organization — used to resolve the
   * `learner` role when an admin adds an employee (`specs/rbac.md` §3.4).
   * Keys are unique per organization (`UNIQUE (organization_id, key)`), so
   * this is at most one row.
   */
  async findByKey(scope: OrgScope, key: string) {
    const rows = await this.db.all<{
      id: number;
      key: string;
      label: string;
      portal: RolePortal;
    }>(sql`
      SELECT r.id, r.key, r.label, r.portal
      FROM roles r
      WHERE r.key = ${key} AND ${orgScope('r', scope)}
    `);
    return rows[0] ?? null;
  }

  async keyExists(scope: OrgScope, key: string): Promise<boolean> {
    const rows = await this.db.all<{ one: number }>(sql`
      SELECT 1 AS one FROM roles
      WHERE key = ${key} AND ${orgScope('roles', scope)}
    `);
    return rows.length > 0;
  }

  /**
   * Every role in the org that can still administer it: an admin-portal role
   * holding `manage_roles`, with at least one active user. The lockout guards
   * in the service ask this before and after a change (§3.8).
   */
  async administeringRoles(
    scope: OrgScope,
  ): Promise<{ id: number; key: string; users: number }[]> {
    return this.db.all<{ id: number; key: string; users: number }>(sql`
      SELECT r.id, r.key, COUNT(u.id) AS users
      FROM roles r
      JOIN role_permissions rp
        ON rp.role_id = r.id AND rp.permission = 'manage_roles'
      LEFT JOIN users u ON u.role_id = r.id AND u.is_active = 1
      WHERE r.portal = 'admin' AND ${orgScope('r', scope)}
      GROUP BY r.id, r.key
      HAVING COUNT(u.id) > 0
    `);
  }

  /**
   * Admin-portal roles holding `manage_roles` with at least one active user,
   * EXCLUDING one role id. Lets the service ask "if this role lost it, would
   * anyone still be able to administer the organization?" BEFORE writing —
   * which is what makes a transaction unnecessary here (§3.8).
   */
  async administeringRolesExcept(
    scope: OrgScope,
    excludeRoleId: number,
  ): Promise<{ id: number; key: string }[]> {
    return this.db.all<{ id: number; key: string }>(sql`
      SELECT r.id, r.key
      FROM roles r
      JOIN role_permissions rp
        ON rp.role_id = r.id AND rp.permission = 'manage_roles'
      JOIN users u ON u.role_id = r.id AND u.is_active = 1
      WHERE r.portal = 'admin' AND r.id <> ${excludeRoleId}
        AND ${orgScope('r', scope)}
      GROUP BY r.id, r.key
    `);
  }

  async create(
    scope: OrgScope,
    values: {
      key: string;
      label: string;
      portal: string;
      scope: string;
    },
  ): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO roles (organization_id, key, label, portal, scope, is_system)
      VALUES (${scope.organizationId}, ${values.key}, ${values.label},
              ${values.portal}, ${values.scope}, false)
      RETURNING id
    `);
    return rows[0].id;
  }

  async updateMeta(
    scope: OrgScope,
    roleId: number,
    values: { label?: string; scope?: string },
  ): Promise<void> {
    if (values.label !== undefined) {
      await this.db.run(sql`
        UPDATE roles SET label = ${values.label}
        WHERE id = ${roleId} AND ${orgScope('roles', scope)}
      `);
    }
    if (values.scope !== undefined) {
      await this.db.run(sql`
        UPDATE roles SET scope = ${values.scope}
        WHERE id = ${roleId} AND ${orgScope('roles', scope)}
      `);
    }
  }

  /**
   * Replaces a role's permissions wholesale.
   *
   * Delete-then-insert rather than diffing: the roles screen sends the complete
   * set it wants, and two statements are cheaper and far easier to reason about
   * than computing an add/remove delta.
   *
   * There is a brief window between the two where the role holds nothing. That
   * is acceptable here and not worth a transaction: the only reader is
   * `AuthGuard`, and the version bump that follows invalidates every token in
   * the organization anyway, so nobody is authorized off a half-written set.
   */
  async replacePermissions(
    scope: OrgScope,
    roleId: number,
    permissions: readonly string[],
  ): Promise<void> {
    await this.db.run(sql`
      DELETE FROM role_permissions
      WHERE role_id IN (
        SELECT id FROM roles WHERE id = ${roleId} AND ${orgScope('roles', scope)}
      )
    `);
    if (permissions.length === 0) return;
    // One multi-row INSERT, fully parameterised (§7.1 — not one statement per
    // permission). Interpolating a JS array as `${array}::text[]` does NOT
    // work: Drizzle renders it as a record and Postgres answers "cannot cast
    // type record to text[]", so the rows are built with sql.join instead.
    const rows = permissions.map((permission) => sql`(${roleId}, ${permission})`);
    await this.db.run(sql`
      INSERT INTO role_permissions (role_id, permission)
      VALUES ${sql.join(rows, sql`, `)}
    `);
  }

  async remove(scope: OrgScope, roleId: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM roles WHERE id = ${roleId} AND ${orgScope('roles', scope)}
    `);
  }

  /**
   * Bumps the organization's permission version. Called in the same
   * transaction as every role write, which is what makes `AuthGuard` reject
   * tokens signed before the change (§3.6).
   */
  async bumpPermVersion(scope: OrgScope): Promise<number> {
    const rows = await this.db.all<{ perm_version: number }>(sql`
      UPDATE organizations SET perm_version = perm_version + 1
      WHERE id = ${scope.organizationId}
      RETURNING perm_version
    `);
    return Number(rows[0].perm_version);
  }

  /**
   * Bumps ONE user's token version, so moving them to another role signs out
   * only them (§3.6). Using the organization's version here would sign out
   * everybody every time an admin added an employee.
   */
  async bumpUserPermVersion(scope: OrgScope, userId: number): Promise<void> {
    await this.db.run(sql`
      UPDATE users SET perm_version = perm_version + 1
      WHERE id = ${userId} AND ${orgScope('users', scope)}
    `);
  }

  /** Moves a user onto a role. The composite FK rejects a foreign-org role. */
  async assignRole(
    scope: OrgScope,
    userId: number,
    roleId: number,
    portal: string,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE users
         SET role_id = ${roleId},
             -- Derived from the role's portal, never supplied by the caller,
             -- so users.role and roles.portal cannot disagree (§3.4).
             role = ${portal}
       WHERE id = ${userId} AND ${orgScope('users', scope)}
    `);
  }
}
