import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { CurrentUser, Permissions, PlatformAdmin } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { CreateOrganizationUserDto } from './dto/platform-user.dto';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { PlatformRolesService } from './platform-roles.service';

/**
 * A platform super-admin administering ONE organization's roles and users —
 * `specs/rbac.md` §3.9.
 *
 * `@PlatformAdmin()` at the class level is load-bearing, not decoration. Every
 * route here turns an `:organizationId` PATH PARAM into an `OrgScope` via
 * `OrganizationsService.scopeFor()`, which is the only minter of a scope that
 * does not come from the caller's own token. Behind this guard that is
 * delegation; behind `@Roles('admin')` it would be a cross-tenant write, since
 * any org admin could then edit any organization by changing a number in the
 * URL. **Do not add a route to this controller that is not covered by it, and
 * do not remove it from the class.**
 *
 * Reads need only the guard; writes additionally require the same permissions
 * the org-admin controller requires, so a platform-org role can be given the
 * ability to look without the ability to change — and so the two audiences
 * cannot drift apart on what a write costs.
 *
 * Mounted as a separate controller per audience (`BACKEND_STRUCTURE.md` §2.2)
 * rather than adding a role branch to `AdminRolesController`: the audience is
 * then visible in the filename and enforced by one decorator, instead of by an
 * `if` someone can forget.
 */
@Controller('platform/organizations/:organizationId')
@PlatformAdmin()
export class PlatformRolesController {
  constructor(private readonly platformRoles: PlatformRolesService) {}

  /** That org's roles with full `permissions[]`, plus the code catalogue. */
  @Get('roles')
  async list(@Param('organizationId', ParseIntPipe) organizationId: number) {
    return this.platformRoles.list(organizationId);
  }

  @Post('roles')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_roles')
  async create(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Body() dto: CreateRoleDto,
  ) {
    return this.platformRoles.create(organizationId, dto);
  }

  @Patch('roles/:roleId')
  @Permissions('manage_roles')
  async update(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Param('roleId', ParseIntPipe) roleId: number,
    @Body() dto: UpdateRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // The actor's own role id comes from the verified token, never the body —
    // see PlatformRolesService.update for why it is passed through unchanged
    // rather than nulled for a cross-org edit.
    return this.platformRoles.update(organizationId, roleId, dto, user.roleId);
  }

  @Delete('roles/:roleId')
  @Permissions('manage_roles')
  async remove(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Param('roleId', ParseIntPipe) roleId: number,
  ) {
    return this.platformRoles.remove(organizationId, roleId);
  }

  /**
   * Creates a user in this organization on one of its roles — an extra admin,
   * a trainer, a learner, or anything the org has defined.
   *
   * Replaces `POST /platform/organizations/:id/admins`, which could only make
   * an admin and, once `users.role_id` became NOT NULL, could not make even
   * that (§3.4). Retired rather than kept beside this one: two endpoints
   * creating a user is how they come to disagree about what a valid user is.
   */
  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_users')
  async createUser(
    @Param('organizationId', ParseIntPipe) organizationId: number,
    @Body() dto: CreateOrganizationUserDto,
  ) {
    return this.platformRoles.createUser(organizationId, dto);
  }
}
