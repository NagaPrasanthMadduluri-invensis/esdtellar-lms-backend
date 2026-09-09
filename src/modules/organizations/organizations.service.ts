import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';

import { hashPassword } from '@/common/crypto/password.util';
import { SYSTEM_ROLES, type RolePortal } from '@/common/permissions';
import { createOrgScope, type OrgScope } from '@/database/org-scope';

import type {
  CreateOrganizationDto,
  UpdateOrganizationDto,
} from './dto/organization.dto';
import {
  OrganizationsRepository,
  type OrganizationRow,
} from './organizations.repository';
import {
  PlatformAnalyticsRepository,
  type OrganizationStatsRow,
} from './platform-analytics.repository';

/** Camel-cased, boolean-normalised shape every endpoint returns for an org. */
export interface OrganizationDto {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  isPlatform: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface OrganizationStatsDto {
  learners: number;
  admins: number;
  courses: number;
  sessions: number;
  completions: number;
  /** Rounded to one decimal place; excludes SCORM — see the repository doc. */
  /**
   * Video watch time plus declared durations for non-SCORM lessons, in
   * minutes. Deliberately NOT called "hours".
   *
   * `modules/learning-hours` owns the single definition of a learning hour
   * (BACKEND_STRUCTURE.md §10.4) and it INCLUDES SCORM's self-reported
   * total_time — a driver-formatted string parsed per learner in JS, which
   * cannot be summed in a cross-org GROUP BY without reimplementing that
   * parser in SQL. Reusing LearningHoursService here would mean one query per
   * organization, which is the fan-out §3.8 exists to avoid.
   *
   * So this is a platform-monitoring approximation under an honest name,
   * rather than a second figure competing for the word "hours". §10.4 records
   * that the admin side once "counted no SCORM at all" and the same learner
   * read differently depending on who looked; naming this field for what it
   * measures is what stops that recurring.
   */
  trackedMinutes: number;
}

/**
 * Resolves the platform organization's id ONCE at boot and holds it in
 * memory for the lifetime of the process. Every later phase depends on this
 * value — `@PlatformAdmin()`, the global course/SCORM catalogue, cross-org
 * analytics — so it is looked up here rather than hard-coded (it is `9` on
 * this database; a fresh install will get a different id).
 *
 * Also owns the platform's organization CRUD and cross-org analytics
 * (`modules/platform/` was folded into this existing module rather than
 * duplicated — see the task brief). It exports itself only; both repositories
 * it depends on stay unexported (`BACKEND_STRUCTURE.md` §3.2).
 */
@Injectable()
export class OrganizationsService implements OnModuleInit {
  private readonly logger = new Logger(OrganizationsService.name);
  private platformOrganizationId: number | null = null;

  constructor(
    private readonly repository: OrganizationsRepository,
    private readonly analytics: PlatformAnalyticsRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    const id = await this.repository.findPlatformOrganizationId();
    if (id === null) {
      // Every downstream phase assumes this exists (spec §3.2). Failing boot
      // loudly here is far cheaper than every org admin silently being able
      // to reach platform-only routes because the check never had anything
      // to compare against.
      throw new Error(
        'OrganizationsService: no organization has is_platform = true. ' +
          'Create the platform organization before starting the server.',
      );
    }

    this.platformOrganizationId = id;
    this.logger.log(`Platform organization resolved: id=${id}`);
  }

  /** The platform organization's id, resolved once at boot. Never a literal. */
  getPlatformOrganizationId(): number {
    if (this.platformOrganizationId === null) {
      throw new Error(
        'OrganizationsService: platform organization id read before onModuleInit ran',
      );
    }
    return this.platformOrganizationId;
  }

  /**
   * Mints an `OrgScope` for a TARGET organization — `specs/rbac.md` §3.9.
   *
   * READ THIS BEFORE ADDING A CALLER. `TenantContextGuard` is otherwise the
   * only thing that mints a scope, and it takes `organizationId` from the
   * verified JWT, which is what makes a tenant scope unforgeable
   * (`multi-tenancy.md` §3.1). This method is the one exception, and it exists
   * because delegated administration genuinely needs it: a platform admin
   * editing organization 11's roles carries a token that says 9.
   *
   * Three things make it safe, and all three have to hold:
   *
   *   1. **Only `@PlatformAdmin()` routes may call it.** That guard has
   *      already established `role === 'admin' AND organizationId ===
   *      platformOrgId`. A caller behind any weaker guard — `@Roles('admin')`,
   *      or nothing — would be a cross-tenant write, because `organizationId`
   *      would then be an ordinary path parameter that any org admin could
   *      change. There is no way to assert that from in here, which is why
   *      this docblock is the assertion.
   *   2. The id is resolved against a real `organizations` row first, so an
   *      invented or deleted id is a 404 rather than a scope over nothing.
   *   3. It lives here, on the service that already owns every cross-org read,
   *      so there is one place to audit rather than a helper any module can
   *      reach for.
   *
   * The returned scope carries the platform org id as usual, so a delegated
   * read sees the target org's own rows plus global platform content, exactly
   * as that organization's own admin would.
   */
  async scopeFor(organizationId: number): Promise<OrgScope> {
    const organization = await this.repository.findById(organizationId);
    if (!organization) throw new NotFoundException('Organization not found');

    return createOrgScope(organization.id, this.getPlatformOrganizationId());
  }

  /** `GET /api/platform/organizations` — every org with its own counts. */
  async listOrganizations(): Promise<{
    organizations: (OrganizationDto & OrganizationStatsDto)[];
  }> {
    const rows = await this.analytics.listOrganizationStats();
    return {
      organizations: rows.map((row) => {
        const { organization, ...stats } = this.toOrganizationWithStats(row);
        return { ...organization, ...stats };
      }),
    };
  }

  /**
   * `POST /api/platform/organizations` — name + slug, plus the roles the new
   * organization cannot function without (`specs/rbac.md` §3.7).
   *
   * The role seeding is not optional and is not a later step. `users.role_id`
   * is NOT NULL and a role must belong to the same organization, so an org
   * with no roles cannot be given a single user — which is what every
   * organization created here was, until this was fixed: created, listed, and
   * impossible to populate.
   *
   * `SYSTEM_ROLES` comes from the code catalogue, so what a new tenant starts
   * with is decided next to the permissions themselves. `trainer` is
   * deliberately NOT among them (§3.7): not every organization runs its own
   * training, and a super-admin can add it from the roles screen for the ones
   * that do.
   */
  async createOrganization(
    dto: CreateOrganizationDto,
  ): Promise<{ organization: OrganizationDto }> {
    const slug = dto.slug ?? this.deriveSlug(dto.name);

    if (await this.repository.slugExists(slug)) {
      throw new ConflictException(
        `Organization slug "${slug}" is already in use`,
      );
    }

    const created = await this.repository.createWithSystemRoles(
      { name: dto.name, slug },
      SYSTEM_ROLES,
    );

    this.logger.log(
      `Organization created: id=${created.id} slug=${slug} ` +
        `with ${SYSTEM_ROLES.length} system roles`,
    );

    return { organization: this.toOrganization(created) };
  }

  /**
   * `GET /api/platform/organizations/:id` — the organization and its stats.
   *
   * Roles used to come back here too, as a count of permissions per role. They
   * now have their own endpoint (`GET .../roles`, `specs/rbac.md` §3.9)
   * because the platform page no longer just displays them — it edits them,
   * and editing needs each role's actual `permissions[]`, not a number. One
   * endpoint answering "what roles does this org have" rather than two
   * answering it differently.
   */
  async getOrganization(id: number): Promise<{
    organization: OrganizationDto;
    stats: OrganizationStatsDto;
  }> {
    const row = await this.analytics.getOrganizationStatsById(id);
    if (!row) throw new NotFoundException('Organization not found');

    const { organization, ...stats } = this.toOrganizationWithStats(row);
    return { organization, stats };
  }

  /** `PATCH /api/platform/organizations/:id` — rename, activate/deactivate. */
  async updateOrganization(
    id: number,
    dto: UpdateOrganizationDto,
  ): Promise<{ organization: OrganizationDto }> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException('Organization not found');

    // Deactivating (is_active = 0) never deletes anything — every downstream
    // table still carries the org's data, just no longer reachable through a
    // login for that org's users, exactly like `UsersRepository.setActive`.
    const updated = await this.repository.update(id, {
      name: dto.name,
      isActive: dto.isActive === undefined ? undefined : dto.isActive ? 1 : 0,
    });
    if (!updated) throw new NotFoundException('Organization not found');

    return { organization: this.toOrganization(updated) };
  }

  /**
   * Creates a user inside an organization, on a role a super-admin has picked
   * — `specs/rbac.md` §3.9. Called by `PlatformRolesService`, which has
   * already resolved the role against that same organization.
   *
   * This was `createOrganizationAdmin`, which could only ever mint an admin
   * and — after `users.role_id` became NOT NULL — could not mint anything at
   * all without a 500 (§3.4). The role is now a parameter, which is the whole
   * point of the change: a super-admin can add a second admin, a trainer, or
   * a learner, under the organization they are looking at.
   *
   * It still mints an ORG user and never a platform admin: `organizationId`
   * comes from the route param and is resolved against a real organization
   * row before any insert, and the platform organization's own admin is
   * created once at install time by `scripts/create-platform-admin.mjs`. An
   * org admin created this way can in turn only create users within their own
   * `OrgScope`, so this remains the one place that would otherwise have been
   * able to plant one by accident.
   */
  async createOrganizationUser(
    organizationId: number,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      password: string;
      roleId: number;
      role: RolePortal;
      department?: string | null;
      jobRole?: string | null;
    },
  ) {
    const organization = await this.repository.findById(organizationId);
    if (!organization) throw new NotFoundException('Organization not found');

    if (await this.repository.emailExists(input.email)) {
      throw new ConflictException('Email already in use');
    }

    const user = await this.repository.createUser(organizationId, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      passwordHash: hashPassword(input.password),
      roleId: input.roleId,
      role: input.role,
      department: input.department ?? null,
      jobRole: input.jobRole ?? null,
    });

    this.logger.log(
      `Platform admin created user=${user.id} role=${input.role} ` +
        `roleId=${input.roleId} in organization=${organizationId}`,
    );

    return { user };
  }

  /** `GET /api/platform/analytics` — per-org rollup plus the platform total. */
  async getAnalytics(): Promise<{
    byOrganization: ({ organizationId: number } & Omit<OrganizationDto, 'id' | 'logoUrl' | 'createdAt'> &
      OrganizationStatsDto)[];
    totals: { organizations: number } & OrganizationStatsDto;
  }> {
    const rows = await this.analytics.listOrganizationStats();

    const byOrganization = rows.map((row) => {
      const { organization, ...stats } = this.toOrganizationWithStats(row);
      return {
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        isPlatform: organization.isPlatform,
        isActive: organization.isActive,
        ...stats,
      };
    });

    const totals = byOrganization.reduce(
      (acc, row) => ({
        organizations: acc.organizations + 1,
        learners: acc.learners + row.learners,
        admins: acc.admins + row.admins,
        courses: acc.courses + row.courses,
        sessions: acc.sessions + row.sessions,
        completions: acc.completions + row.completions,
        trackedMinutes:
          Math.round((acc.trackedMinutes + row.trackedMinutes) * 10) / 10,
      }),
      {
        organizations: 0,
        learners: 0,
        admins: 0,
        courses: 0,
        sessions: 0,
        completions: 0,
        trackedMinutes: 0,
      },
    );

    return { byOrganization, totals };
  }

  /**
   * lowercase, non-alphanumerics collapsed to single hyphens, no leading or
   * trailing hyphen. Used only when `POST /platform/organizations` omits
   * `slug` — a duplicate result is still rejected with 409 by the caller.
   */
  private deriveSlug(name: string): string {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return slug.length > 0 ? slug : 'org';
  }

  private toOrganization(row: OrganizationRow): OrganizationDto {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      logoUrl: row.logoUrl,
      isPlatform: row.isPlatform,
      isActive: row.isActive === 1,
      createdAt: row.createdAt,
    };
  }

  private toOrganizationWithStats(
    row: OrganizationStatsRow,
  ): { organization: OrganizationDto } & OrganizationStatsDto {
    return {
      organization: {
        id: row.organization_id,
        name: row.name,
        slug: row.slug,
        logoUrl: row.logo_url,
        isPlatform: row.is_platform,
        isActive: Number(row.is_active) === 1,
        createdAt: row.created_at,
      },
      learners: Number(row.learners),
      admins: Number(row.admins),
      courses: Number(row.courses),
      sessions: Number(row.sessions),
      completions: Number(row.completions),
      trackedMinutes: Math.round(Number(row.minutes) * 10) / 10,
    };
  }
}
