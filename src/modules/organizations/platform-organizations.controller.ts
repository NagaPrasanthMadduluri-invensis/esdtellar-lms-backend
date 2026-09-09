import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { PlatformAdmin } from '@/common/decorators';

import {
  CreateOrganizationDto,
  UpdateOrganizationDto,
} from './dto/organization.dto';
import { OrganizationsService } from './organizations.service';

/**
 * The super-admin organization CRUD surface. `@PlatformAdmin()` at the class
 * level enforces `role === 'admin' AND organizationId === platformOrgId` on
 * every route here — no per-handler `if (role === ...)` to forget
 * (`BACKEND_STRUCTURE.md` §5.2).
 */
@Controller('platform/organizations')
@PlatformAdmin()
export class PlatformOrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  async list() {
    return this.organizations.listOrganizations();
  }

  @Post()
  async create(@Body() dto: CreateOrganizationDto) {
    return this.organizations.createOrganization(dto);
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.organizations.getOrganization(id);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOrganizationDto,
  ) {
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
