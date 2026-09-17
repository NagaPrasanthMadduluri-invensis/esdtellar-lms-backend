import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';

import { hashPassword } from '@/common/crypto/password.util';
import { SYSTEM_ROLES, type RolePortal } from '@/common/permissions';
import { contractState } from '@/common/tenant-account';
import { BillingService } from '@/modules/billing/billing.service';
import { SeatsService } from '@/modules/seats/seats.service';
import { createOrgScope, type OrgScope } from '@/database/org-scope';

import type { UpdateOrgSettingsDto } from './dto/org-settings.dto';
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
    private readonly billing: BillingService,
    // `seat_limit` lives on `organizations`, but SeatsService is its one
    // writer — see `createOrganization`.
    private readonly seats: SeatsService,
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

  /**
   * Name and status for one organization, with no stats behind it.
   *
   * `getOrganization` answers the same question but runs the full cross-org
   * analytics query to do it, which is the wrong price for a caller that only
   * needs a name — the support-session sign-in, for one.
   */
  async findOrganizationSummary(id: number): Promise<OrganizationDto | null> {
    const row = await this.repository.findById(id);
    return row ? this.toOrganization(row) : null;
  }

  /* ── The tenant's own view of itself ──────────────────────────────────── */

  /**
   * `GET /api/admin/organization` — what a tenant admin sees about their own
   * account.
   *
   * The organization comes from the caller's `OrgScope`, never a path
   * parameter, so there is nothing here to point at somebody else's tenant.
   *
   * The response deliberately mixes two kinds of field and the shape says
   * which is which: `editable` is what `manage_organization` may write, and
   * `commercial` is what only Edstellar may write but the customer is
   * entitled to READ — they signed the contract, they should be able to see
   * its dates without asking. Splitting them in the payload is what lets the
   * dialog render the second group as facts rather than as inputs that fail.
   */
  async getOwnOrganization(scope: OrgScope) {
    const row = await this.analytics.getOrganizationStatsById(
      scope.organizationId,
    );
    if (!row) throw new NotFoundException('Organization not found');

    const contract = contractState(row.contract_end);
    const seats = await this.seats.usage(scope);

    return {
      organization: {
        id: row.organization_id,
        name: row.name,
        slug: row.slug,
        industry: row.industry,
        region: row.region,
        created_at: row.created_at,

        /** Read-only here. Written only by `@PlatformAdmin()` routes. */
        plan: row.plan,
        billing_cycle: row.billing_cycle,
        contract_start: row.contract_start,
        contract_end: row.contract_end,
        contract_value:
          row.contract_value === null ? null : Number(row.contract_value),
        contract_state: contract.state,
        contract_days_left: contract.daysLeft,

        seat_limit: seats.limit,
        seats_used: seats.used,
        seats_remaining: seats.remaining,

        learners: Number(row.learners),
        admins: Number(row.admins),
        courses: Number(row.courses),
        sessions: Number(row.sessions),
        completions: Number(row.completions),
      },
    };
  }

  /** `PATCH /api/admin/organization` — name, industry, region. Nothing else. */
  async updateOwnOrganization(scope: OrgScope, dto: UpdateOrgSettingsDto) {
    // Passed field by field rather than spread, so widening the DTO can never
    // silently widen what a tenant may write to its own row.
    await this.repository.update(scope.organizationId, {
      name: dto.name,
      industry: dto.industry,
      region: dto.region,
    });
    return this.getOwnOrganization(scope);
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

    /*
     * Both conflicts are checked BEFORE anything is written.
     *
     * The transaction below would roll the organization back on a duplicate
     * email anyway, but the caller would get a Postgres constraint error
     * instead of a sentence naming which field is the problem — and a form
     * that says "duplicate key value violates unique constraint" has told the
     * admin nothing they can act on.
     */
    if (await this.repository.slugExists(slug)) {
      throw new ConflictException(
        `Organization slug "${slug}" is already in use`,
      );
    }
    if (await this.repository.emailExists(dto.admin.email)) {
      throw new ConflictException(
        `${dto.admin.email} already has an account. Every login is unique across ` +
          'the whole platform, not just within one tenant.',
      );
    }

    const { organization: created, owner } =
      await this.repository.createWithSystemRoles(
        { name: dto.name, slug },
        SYSTEM_ROLES,
        {
          firstName: dto.admin.firstName,
          lastName: dto.admin.lastName,
          email: dto.admin.email,
          passwordHash: hashPassword(dto.admin.password),
        },
      );

    /*
     * The profile, the contract and the seat limit are a second write, and
     * deliberately not part of the transaction: they are all optional, and a
     * mistyped contract date must not cost the tenant its admin account. If
     * this fails the tenant still exists and works; the terms are editable
     * from the directory.
     */
    const hasProfile =
      dto.industry !== undefined || dto.region !== undefined ||
      dto.plan !== undefined || dto.billingCycle !== undefined ||
      dto.contractStart !== undefined || dto.contractEnd !== undefined ||
      dto.contractValue !== undefined;

    if (hasProfile) {
      await this.repository.update(created.id, {
        industry: dto.industry,
        region: dto.region,
        plan: dto.plan,
        billingCycle: dto.billingCycle,
        contractStart: dto.contractStart,
        contractEnd: dto.contractEnd,
        // `numeric` takes a string, the same conversion `updateOrganization`
        // makes — never a float handed straight to the driver.
        contractValue:
          dto.contractValue === undefined || dto.contractValue === null
            ? dto.contractValue
            : String(dto.contractValue),
      });
    }

    // Through SeatsService, never a second UPDATE written here — one writer
    // for `seat_limit`, so the directory and the seat queue cannot disagree
    // about what a tenant is entitled to.
    if (dto.seatLimit !== undefined) {
      await this.seats.setLimit(created.id, { seat_limit: dto.seatLimit });
    }

    this.logger.log(
      `Organization created: id=${created.id} slug=${slug} ` +
        `with ${SYSTEM_ROLES.length} system roles and admin user=${owner?.id}`,
    );

    const fresh = (await this.repository.findById(created.id)) ?? created;
    return { organization: this.toOrganization(fresh) };
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
    // Every field passed through as-is: `undefined` means the caller did not
    // send it and the repository leaves it alone, `null` means clear it. The
    // difference is load-bearing here — an edit form that posts its whole
    // object must not blank a contract value nobody touched.
    const updated = await this.repository.update(id, {
      name: dto.name,
      isActive: dto.isActive === undefined ? undefined : dto.isActive ? 1 : 0,
      industry: dto.industry,
      region: dto.region,
      contactName: dto.contactName,
      contactEmail: dto.contactEmail,
      contactPhone: dto.contactPhone,
      contractStart: dto.contractStart,
      contractEnd: dto.contractEnd,
      contractValue:
        dto.contractValue === undefined
          ? undefined
          : dto.contractValue === null
            ? null
            : String(dto.contractValue),
      plan: dto.plan,
      billingCycle: dto.billingCycle,
      notes: dto.notes,
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

  /**
   * `GET /api/platform/tenants` — the tenant directory.
   *
   * Everything a super admin needs about an account on one row: the profile,
   * the contract, and the usage counts the analytics query already computes.
   * A separate method from `getAnalytics()` rather than a widening of it,
   * because that one is a numeric rollup with a typed shape two other callers
   * depend on.
   *
   * The PLATFORM organization is excluded. It is not a customer — it holds
   * global content and Edstellar's own staff — and listing it beside real
   * tenants would put a row in the directory that has no contract, can never
   * have one, and would drag every average down.
   */
  async listTenants() {
    // Money comes from BillingService, not a second query written here — one
    // definition of what "collected" and "outstanding" mean, shared with the
    // invoices page (§3.2: the module, never its repository).
    const [rows, money] = await Promise.all([
      this.analytics.listOrganizationStats(),
      this.billing.totalsByOrganization(),
    ]);

    const tenants = rows
      .filter((row) => !row.is_platform)
      .map((row) => {
        const contract = contractState(row.contract_end);
        const billing = money.get(row.organization_id) ?? {
          invoiced: 0,
          collected: 0,
          outstanding: 0,
          overdue_count: 0,
        };
        return {
          id: row.organization_id,
          name: row.name,
          slug: row.slug,
          logo_url: row.logo_url,
          is_active: Number(row.is_active) === 1,
          created_at: row.created_at,

          industry: row.industry,
          region: row.region,
          /* The COMMERCIAL contact: typed in, optional, and about billing.
             Deliberately kept apart from `admin_*` below, which is the real
             account — the card used to show only this one and so named a
             person nothing in the system could verify. */
          contact_name: row.contact_name,
          contact_email: row.contact_email,
          contact_phone: row.contact_phone,

          /* The tenant's real admin account, from `users`. */
          admin_name: row.admin_name,
          admin_email: row.admin_email,
          admin_is_owner: row.admin_is_owner === true,
          admin_portal_count: Number(row.admin_portal_count ?? 0),

          contract_start: row.contract_start,
          contract_end: row.contract_end,
          // `numeric` arrives as a string from pg. Converted once, here, so no
          // caller has to remember — and null stays null rather than becoming 0,
          // because "no contract recorded" and "a contract worth nothing" are
          // different facts.
          contract_value:
            row.contract_value === null ? null : Number(row.contract_value),
          plan: row.plan,
          billing_cycle: row.billing_cycle,
          notes: row.notes,

          /** Derived from the date every time — never a stored status. */
          contract_state: contract.state,
          contract_days_left: contract.daysLeft,

          invoiced: billing.invoiced,
          collected: billing.collected,
          outstanding: billing.outstanding,
          overdue_count: billing.overdue_count,

          learners: Number(row.learners),
          admins: Number(row.admins),
          courses: Number(row.courses),
          sessions: Number(row.sessions),
          completions: Number(row.completions),
          tracked_minutes: Number(row.minutes),
        };
      });

    return {
      tenants,
      counts: {
        total: tenants.length,
        active: tenants.filter((t) => t.is_active).length,
        suspended: tenants.filter((t) => !t.is_active).length,
        expiring: tenants.filter((t) => t.contract_state === 'expiring').length,
        expired: tenants.filter((t) => t.contract_state === 'expired').length,
        learners: tenants.reduce((a, t) => a + t.learners, 0),
        // Rounded to paise once, at the end — summing floats that were each
        // already rounded is how a total drifts from its own rows.
        invoiced: round2(tenants.reduce((a, t) => a + t.invoiced, 0)),
        collected: round2(tenants.reduce((a, t) => a + t.collected, 0)),
        outstanding: round2(tenants.reduce((a, t) => a + t.outstanding, 0)),
        overdue: tenants.reduce((a, t) => a + t.overdue_count, 0),
        contract_value: round2(
          tenants.reduce((a, t) => a + (t.contract_value ?? 0), 0),
        ),
      },
    };
  }

  /**
   * `GET /api/platform/access` — every privileged account, across tenants.
   *
   * TWO levels only, Owner and Admin, both derived from the role the user
   * actually holds. The reference offers four; the other two (Billing,
   * Auditor) gate nothing in this system, and shipping a level that enforces
   * nothing is exactly the defect §5.2.1 exists to prevent. They go in when
   * something checks them.
   *
   * Edstellar's own staff are included and flagged `is_platform_org`, because
   * "who can act on any tenant" is precisely the question this page answers —
   * omitting the most privileged accounts of all would make it a liability.
   */
  async listPrivilegedAccounts() {
    const rows = await this.analytics.listPrivilegedAccounts();

    const accounts = rows.map((row) => ({
      id: row.id,
      name: `${row.first_name} ${row.last_name}`.trim(),
      email: row.email,
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      is_platform_org: row.is_platform_org,
      level: row.level,
      role_name: row.role_name,
      /** A suspended ACCOUNT, not a suspended tenant — the two differ. */
      status: Number(row.is_active) === 1 ? 'active' : 'suspended',
      granted_at: row.granted_at,
      last_active: row.last_active,
    }));

    return {
      accounts,
      counts: {
        total: accounts.length,
        active: accounts.filter((a) => a.status === 'active').length,
        suspended: accounts.filter((a) => a.status === 'suspended').length,
        owners: accounts.filter((a) => a.level === 'owner').length,
        platform: accounts.filter((a) => a.is_platform_org).length,
      },
    };
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

/** Money to paise. Applied ONCE to a total, never to each addend. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
