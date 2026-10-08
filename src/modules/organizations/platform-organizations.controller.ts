import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
} from './dto/organization.dto';
import { OrganizationsService } from './organizations.service';
import { PublicIdService } from '@/database/public-id.service';

/**
 * The super-admin organization CRUD surface. `@PlatformAdmin()` at the class
 * level enforces `role === 'admin' AND organizationId === platformOrgId` on
 * every route here — no per-handler `if (role === ...)` to forget
 * (`BACKEND_STRUCTURE.md` §5.2).
 */
@Controller('platform/organizations')
@PlatformAdmin()
export class PlatformOrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    // :id is now the org's public UUID (0046); resolve it to the integer id,
    // still accepting a bare integer during the transition. The literal
    // `tenants`/`access` routes are declared above `:id`, so they are never
    // captured by it.
    private readonly publicId: PublicIdService,
  ) {}

  /**
   * The tenant directory: profile, contract and usage on one row, with the
   * renewal state derived from the contract date.
   *
   * Declared BEFORE `@Get(':id')` — Nest matches in declaration order and
   * `tenants` would otherwise arrive as an organization id.
   */
  @Get("tenants")
  async tenants() {
    return this.organizations.listTenants();
  }

  /**
   * Every privileged account across every tenant. Declared before `:id` for
   * the same route-ordering reason as `tenants` above.
   */
  @Get("access")
  async access() {
    return this.organizations.listPrivilegedAccounts();
  }

  @Get()
  async list() {
    return this.organizations.listOrganizations();
  }

  @Post()
  async create(@Body() dto: CreateOrganizationDto) {
    return this.organizations.createOrganization(dto);
  }

  @Get(':id')
  async get(@Param('id') idParam: string) {
    const id = await this.publicId.resolveIdOrThrow('organizations', idParam);
    return this.organizations.getOrganization(id);
  }

  @Patch(':id')
  async update(
    @Param('id') idParam: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    const id = await this.publicId.resolveIdOrThrow('organizations', idParam);
    return this.organizations.updateOrganization(id, dto);
  }

  /**
   * Creating a user in this organization lives in
   * `PlatformRolesController` — `POST /platform/organizations/:id/users`.
   *
   * `POST :id/admins` used to be here. It could only ever mint an admin, and
   * once `users.role_id` became NOT NULL it could not mint even that
   * (`specs/rbac.md` §3.4). Its replacement takes the role as a parameter, so
   * it needs to resolve a role inside the target organization — which is the
   * roles module's job, not this one's.
   */
}
