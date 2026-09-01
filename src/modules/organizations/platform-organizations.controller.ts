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
  CreateOrganizationAdminDto,
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

  /** Seeds the organization's first admin — see `OrganizationsService` for why. */
  @Post(':id/admins')
  async createAdmin(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateOrganizationAdminDto,
  ) {
    return this.organizations.createOrganizationAdmin(id, dto);
  }
}
