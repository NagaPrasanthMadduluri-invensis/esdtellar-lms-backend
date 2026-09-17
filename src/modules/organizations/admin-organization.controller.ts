import { Body, Controller, Get, Patch } from '@nestjs/common';

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';

import { UpdateOrgSettingsDto } from './dto/org-settings.dto';
import { OrganizationsService } from './organizations.service';

/**
 * A tenant admin reading and editing THEIR OWN organization.
 *
 * A second controller beside `PlatformOrganizationsController`, never a
 * widening of it (§2.2). The platform one takes an organization id in the
 * path and is guarded by `@PlatformAdmin()`; this one takes no id at all —
 * the organization comes from `@CurrentScope()`, which is minted from the
 * verified JWT and cannot be steered by the caller. That difference is the
 * whole boundary: there is no parameter here for an org admin to change.
 *
 * The read is open to the admin audience because an admin who cannot see
 * their own organization's name cannot do much; the WRITE carries
 * `manage_organization`, so an org can hand out a restricted admin role that
 * manages users without being able to rename the company.
 */
@Controller('admin/organization')
@Roles('admin')
export class AdminOrganizationController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  async get(@CurrentScope() scope: OrgScope) {
    return this.organizations.getOwnOrganization(scope);
  }

  @Patch()
  @Permissions('manage_organization')
  async update(
    @CurrentScope() scope: OrgScope,
    @Body() dto: UpdateOrgSettingsDto,
  ) {
    return this.organizations.updateOwnOrganization(scope, dto);
  }
}
