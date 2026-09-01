import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';

import { hashPassword } from '@/common/crypto/password.util';

import type {
  CreateOrganizationAdminDto,
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

  /** `POST /api/platform/organizations` — name + slug; slug unique, URL-safe. */
  async createOrganization(
    dto: CreateOrganizationDto,
  ): Promise<{ organization: OrganizationDto }> {
    const slug = dto.slug ?? this.deriveSlug(dto.name);

    if (await this.repository.slugExists(slug)) {
      throw new ConflictException(
        `Organization slug "${slug}" is already in use`,
      );
    }

    const created = await this.repository.create({ name: dto.name, slug });
    return { organization: this.toOrganization(created) };
  }

  /** `GET /api/platform/organizations/:id` — org + its own stats. */
  async getOrganization(
    id: number,
  ): Promise<{ organization: OrganizationDto; stats: OrganizationStatsDto }> {
    const row = await this.analytics.getOrganizationStatsById(id);
    if (!row) throw new NotFoundException('Organization not found');

    const { organization, ...stats } = this.toOrganizationWithStats(row);
    return {
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        logoUrl: organization.logoUrl,
        isPlatform: organization.isPlatform,
        isActive: organization.isActive,
        createdAt: organization.createdAt,
      },
      stats,
    };
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
   * `POST /api/platform/organizations/:id/admins` — seeds that org's FIRST
   * admin.
   *
   * This mints an ORG admin, never a platform admin: `organizationId` is
   * `:id` from the route, resolved against a real organization row before any
   * insert happens, and the platform organization itself gets its own admin
   * once, at install time, never through this endpoint. An org admin created
   * this way can in turn only ever create users within their own `OrgScope`
   * (`UsersService.create`), so this is the one and only place a platform
   * admin could otherwise have been minted by accident — hence the emphasis.
   */
  async createOrganizationAdmin(
    organizationId: number,
    dto: CreateOrganizationAdminDto,
  ): Promise<{ user: Awaited<ReturnType<OrganizationsRepository['createAdmin']>> }> {
    const organization = await this.repository.findById(organizationId);
    if (!organization) throw new NotFoundException('Organization not found');

    if (await this.repository.emailExists(dto.email)) {
      throw new ConflictException('Email already in use');
    }

    const user = await this.repository.createAdmin(organizationId, {
      firstName: dto.firstName,
      lastName: dto.lastName,
      email: dto.email,
      passwordHash: hashPassword(dto.password),
    });

    this.logger.log(
      `First admin seeded for organization=${organizationId}: user=${user.id}`,
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
