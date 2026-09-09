import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { RolePortal } from '@/common/permissions';
import { DatabaseService } from '@/database/database.service';
import { organizations, rolePermissions, roles, users } from '@/database/schema';

export interface OrganizationRow {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  isPlatform: boolean;
  isActive: number;
  createdAt: string;
}

const ORGANIZATION_COLUMNS = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  logoUrl: organizations.logoUrl,
  isPlatform: organizations.isPlatform,
  isActive: organizations.isActive,
  createdAt: organizations.createdAt,
};

/**
 * Deliberately NOT org-scoped, like `auth.repository.ts`: resolving the
 * platform organization's id is what makes `OrgScope` possible in the first
 * place, so it cannot depend on one. The rest of this file's methods are
 * platform-only CRUD over the `organizations` table itself and the creation of
 * a user during organization onboarding — both inherently precede or sit
 * outside any single org's scope, so the same absence of `OrgScope` is correct
 * here too, not a second exception.
 *
 * Listing an organization's roles used to live here as well. It was removed
 * rather than kept alongside `RolesRepository.list`: that method already
 * returns the same rows WITH each role's permissions, and two queries
 * answering "what roles does this org have" is how the platform page and the
 * admin page come to disagree about it.
 */
@Injectable()
export class OrganizationsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async findPlatformOrganizationId(): Promise<number | null> {
    const rows = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.isPlatform, true))
      .limit(1);

    return rows[0]?.id ?? null;
  }

  async findById(id: number): Promise<OrganizationRow | null> {
    const rows = await this.db
      .select(ORGANIZATION_COLUMNS)
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  async slugExists(slug: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);

    return rows.length > 0;
  }

  /**
   * Creates an organization AND the roles it cannot function without, in one
   * transaction — `specs/rbac.md` §3.7.
   *
   * The seeding used to be missing entirely. §3.7 says
   * `createOrganization` seeds three system roles; the code only ever inserted
   * the `organizations` row, so every organization created through the platform
   * UI came up with ZERO roles. Since `users.role_id` is NOT NULL and a role
   * must belong to the same organization, that org could not be given a single
   * user — `POST /platform/organizations/:id/users` answered 404 "Role not
   * found" and there was no role to pick. A new tenant was unusable from the
   * moment it was created, and the only way in was a hand-written INSERT.
   *
   * `transaction` is what makes this safe, and it is a unit of work rather
   * than a business rule, so it belongs here and not in the service (§3.1). If
   * the roles fail to insert, the organization must not exist either: a
   * half-created tenant is exactly the state this method exists to prevent,
   * and it cannot be repaired by retrying, because the second attempt trips
   * the unique slug.
   *
   * The role definitions are PASSED IN, from `SYSTEM_ROLES` in the code
   * catalogue. This repository holds no opinion about which roles an
   * organization gets — that is policy, and policy lives with the catalogue.
   */
  async createWithSystemRoles(
    input: { name: string; slug: string },
    systemRoles: readonly {
      key: string;
      label: string;
      portal: string;
      scope: string;
      permissions: readonly string[];
    }[],
  ): Promise<OrganizationRow> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizations)
        .values({ name: input.name, slug: input.slug })
        .returning(ORGANIZATION_COLUMNS);

      for (const role of systemRoles) {
        const [row] = await tx
          .insert(roles)
          .values({
            organizationId: created.id,
            key: role.key,
            label: role.label,
            portal: role.portal as 'admin' | 'learner' | 'trainer',
            scope: role.scope as 'org' | 'department' | 'self',
            isSystem: true,
          })
          .returning({ id: roles.id });

        if (role.permissions.length === 0) continue;
        // One multi-row INSERT per role, not one statement per permission
        // (`BACKEND_STRUCTURE.md` §7.1).
        await tx.insert(rolePermissions).values(
          role.permissions.map((permission) => ({
            roleId: row.id,
            permission,
          })),
        );
      }

      return created;
    });
  }

  async update(
    id: number,
    input: { name?: string; isActive?: number },
  ): Promise<OrganizationRow | null> {
    const values: Partial<{ name: string; isActive: number }> = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.isActive !== undefined) values.isActive = input.isActive;

    const [updated] = await this.db
      .update(organizations)
      .set(values)
      .where(eq(organizations.id, id))
      .returning(ORGANIZATION_COLUMNS);

    return updated ?? null;
  }

  /**
   * Deliberately NOT scoped, mirroring `UsersRepository.emailExists`:
   * `users.email` stays globally UNIQUE (spec decision 1), so an address
   * already taken in ANY organization is unavailable here too. This
   * repository never had an `OrgScope` to take in the first place (see the
   * class doc), so unlike `UsersRepository` this is not a documented
   * exception inside an otherwise-scoped file — there is nothing to except it
   * from.
   */
  async emailExists(email: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    return rows.length > 0;
  }

  /**
   * Creates a user inside an organization, on a role that has already been
   * resolved — `specs/rbac.md` §3.9.
   *
   * This was `createAdmin`, hard-coding `role: 'admin'` and writing no
   * `role_id`. Once `migrate-rbac.mjs` set `users.role_id NOT NULL`, that
   * became a not-null violation surfacing as a 500, so organization
   * onboarding was broken from the moment RBAC landed (§3.4). Two things
   * changed: `roleId` is now required, and `role` is passed in as the
   * resolved role's `portal` rather than assumed — which is what lets a
   * super-admin create a trainer or a learner here and not only an admin.
   *
   * `role` and `role_id` are written together from ONE role row, so the
   * denormalisation cannot desync. `RolesService.assign` remains the only
   * method that MOVES a user between roles (§8.3); this one only ever creates.
   *
   * Writes directly into `users` rather than delegating to `UsersModule`:
   * `UsersRepository.createLearner` serves the org-scoped self-service flow
   * and takes an `OrgScope` shaped by the caller's own token, whereas
   * onboarding an organization is a platform concern that precedes it —
   * exactly like every other method in this file.
   *
   * `organizationId` is a plain parameter, never caller-suppliable: the
   * controller reads it from the route param, and the composite FK
   * `users_role_same_org` rejects a `roleId` from any other organization, so
   * this cannot plant a user in a tenant using another tenant's role.
   */
  async createUser(
    organizationId: number,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      passwordHash: string;
      roleId: number;
      /** The role's `portal` — `users.role` stays the portal selector (§3.4). */
      role: RolePortal;
      department: string | null;
      jobRole: string | null;
    },
  ) {
    const [created] = await this.db
      .insert(users)
      .values({
        organizationId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        password: input.passwordHash,
        role: input.role,
        roleId: input.roleId,
        department: input.department,
        jobRole: input.jobRole,
      })
      .returning({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
        roleId: users.roleId,
        organizationId: users.organizationId,
        isActive: users.isActive,
        createdAt: users.createdAt,
      });

    return created;
  }
}
