import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { users } from '@/database/schema';

/**
 * All `users` reads needed by authentication.
 *
 * Repositories are the only place that touches Drizzle. Services never build
 * queries, controllers never see a table — that seam is what makes the data
 * layer swappable and the services testable.
 *
 * Note every method selects an explicit column list. `SELECT *` (what the legacy
 * routes did) pulls the scrypt password hash into scope on every read, which is
 * how it ends up serialised into a response by accident.
 *
 * Deliberately NOT `OrgScope`d, unlike every other repository. Login resolves
 * a globally-unique email (`users.email UNIQUE`, spec decision 1) BEFORE any
 * scope exists — there is no JWT yet to mint one from. This is correct, not
 * an oversight: it is one of exactly two repositories a grep for `orgScope`
 * is expected to miss (the other is `platform-analytics.repository.ts`,
 * spec §4.3/acceptance criterion 6). Do not "fix" this by adding a scope
 * parameter that can never be supplied.
 */
@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Includes the password hash — used ONLY by the login credential check. */
  /**
   * The role, its permissions and the organization's current `perm_version` —
   * everything the token needs beyond identity (`specs/rbac.md` §3.6).
   *
   * One round trip: the permissions arrive aggregated rather than as a second
   * query per login. A user whose `role_id` is null (only possible before the
   * RBAC backfill) resolves to no permissions and the org's version, which is
   * a safe floor — they can still sign in, they simply hold nothing.
   */
  async findRoleContext(
    userId: number,
    organizationId: number,
  ): Promise<{
    roleId: number | null;
    scope: 'org' | 'department' | 'self';
    permissions: string[];
    permVersion: number;
    userPermVersion: number;
  }> {
    const rows = await this.db.all<{
      role_id: number | null;
      scope: string | null;
      permissions: string[] | null;
      perm_version: number;
      user_perm_version: number;
    }>(sql`
      SELECT u.role_id,
             r.scope,
             COALESCE(
               (SELECT array_agg(rp.permission ORDER BY rp.permission)
                  FROM role_permissions rp WHERE rp.role_id = u.role_id),
               ARRAY[]::text[]
             ) AS permissions,
             o.perm_version,
             u.perm_version AS user_perm_version
        FROM users u
        JOIN organizations o ON o.id = u.organization_id
        LEFT JOIN roles r ON r.id = u.role_id
       WHERE u.id = ${userId} AND u.organization_id = ${organizationId}
    `);
    const row = rows[0];
    return {
      roleId: row?.role_id ?? null,
      scope: (row?.scope as 'org' | 'department' | 'self') ?? 'self',
      permissions: row?.permissions ?? [],
      permVersion: Number(row?.perm_version ?? 1),
      userPermVersion: Number(row?.user_perm_version ?? 1),
    };
  }

  /**
   * Both token versions in one round trip, for `AuthGuard` — the
   * organization's (a role's permissions changed) and the user's own (they
   * were moved to a different role). `specs/rbac.md` §3.6.
   *
   * Returns null when the user is gone or deactivated, which the guard turns
   * into a 401 — so deactivating someone now ends their session on their next
   * request instead of when their token expires.
   */
  async findTokenVersions(
    userId: number,
    organizationId: number,
  ): Promise<{ orgVersion: number; userVersion: number } | null> {
    const rows = await this.db.all<{
      org_version: number;
      user_version: number;
    }>(sql`
      SELECT o.perm_version AS org_version, u.perm_version AS user_version
        FROM users u
        JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = ${userId}
         AND u.organization_id = ${organizationId}
         AND u.is_active = 1
    `);
    const row = rows[0];
    return row
      ? {
          orgVersion: Number(row.org_version),
          userVersion: Number(row.user_version),
        }
      : null;
  }

  async findActiveByEmailWithSecret(email: string) {
    const rows = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        password: users.password,
        role: users.role,
        department: users.department,
        isActive: users.isActive,
        organizationId: users.organizationId,
      })
      .from(users)
      .where(and(eq(users.email, email), eq(users.isActive, 1)))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * The caller's own password hash, for `POST /api/auth/change-password`.
   *
   * Named `...WithSecret` like its sibling so the one method that pulls a
   * credential into scope is obvious at the call site (§3.1). Scoped by both
   * id and organization: the id comes from the verified JWT, and adding the
   * org predicate means a stale token cannot reach a row that has since been
   * moved to another tenant.
   */
  async findActiveByIdWithSecret(id: number, organizationId: number) {
    const rows = await this.db
      .select({ id: users.id, password: users.password })
      .from(users)
      .where(
        and(
          eq(users.id, id),
          eq(users.organizationId, organizationId),
          eq(users.isActive, 1),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async updateOwnPassword(
    id: number,
    organizationId: number,
    passwordHash: string,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({ password: passwordHash })
      .where(and(eq(users.id, id), eq(users.organizationId, organizationId)));
  }

  async findActiveById(id: number) {
    const rows = await this.db
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
        department: users.department,
        isActive: users.isActive,
        organizationId: users.organizationId,
      })
      .from(users)
      .where(and(eq(users.id, id), eq(users.isActive, 1)))
      .limit(1);

    return rows[0] ?? null;
  }
}
