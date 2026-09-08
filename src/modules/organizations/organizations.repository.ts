import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { organizations, roles, users } from '@/database/schema';

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
 * platform-only CRUD over the `organizations` table itself and the seeding of
 * an organization's first admin — both inherently precede or sit outside any
 * single org's scope, so the same absence of `OrgScope` is correct here too,
 * not a second exception.
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

  /**
   * An organization's roles, for the platform admin's org detail page
   * (`specs/rbac.md` §3.3). Deliberately unscoped by org in the usual sense —
   * this repository is one of the three legitimately unscoped ones
   * (multi-tenancy.md), and the id is supplied by a `@PlatformAdmin()` route.
   *
   * Holder and permission counts come back as grouped aggregates in the one
   * query rather than a count per role (§7.1).
   */
  async listRoles(organizationId: number) {
    return this.db
      .select({
        id: roles.id,
        key: roles.key,
        label: roles.label,
        portal: roles.portal,
        scope: roles.scope,
        is_system: roles.isSystem,
        // Grouped aggregate and one correlated subquery — not a count per role
        // (BACKEND_STRUCTURE.md §7.1).
        users: sql<number>`count(${users.id})`,
        permissions: sql<number>`(
          SELECT count(*) FROM role_permissions rp WHERE rp.role_id = ${roles.id}
        )`,
      })
      .from(roles)
      .leftJoin(users, and(eq(users.roleId, roles.id), eq(users.isActive, 1)))
      .where(eq(roles.organizationId, organizationId))
      .groupBy(
        roles.id,
        roles.key,
        roles.label,
        roles.portal,
        roles.scope,
        roles.isSystem,
      )
      .orderBy(desc(roles.isSystem), roles.key);
  }

  async slugExists(slug: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .limit(1);

    return rows.length > 0;
  }

  async create(input: { name: string; slug: string }): Promise<OrganizationRow> {
    const [created] = await this.db
      .insert(organizations)
      .values({ name: input.name, slug: input.slug })
      .returning(ORGANIZATION_COLUMNS);

    return created;
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
   * Seeds an organization's FIRST admin.
   *
   * Writes directly into `users` rather than delegating to `UsersModule`:
   * `UsersRepository.createLearner` hard-codes `role: 'learner'` for the
   * org-scoped self-service flow (`POST /api/admin/users`) and takes an
   * `OrgScope` that this call has no business minting — onboarding an
   * organization is a platform-only concern, prior to and outside that org's
   * own scope, exactly like every other method in this file.
   *
   * `organizationId` is a plain parameter, never a caller-suppliable one: the
   * controller reads it from the route param, so this can never be used to
   * plant a platform admin — see `OrganizationsService.createOrganizationAdmin`.
   */
  async createAdmin(
    organizationId: number,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      passwordHash: string;
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
        role: 'admin',
      })
      .returning({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        role: users.role,
        organizationId: users.organizationId,
        isActive: users.isActive,
        createdAt: users.createdAt,
      });

    return created;
  }
}
