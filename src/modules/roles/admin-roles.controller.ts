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

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { RolesService } from './roles.service';

/**
 * An organization admin managing their own organization's roles —
 * `specs/rbac.md` §4.
 *
 * Reads need only `admin`; every WRITE additionally requires `manage_roles`,
 * so an org can define a role that sees the screen without being able to
 * change it. A platform admin has no route here on purpose: editing another
 * organization's roles is an open question in §8.3, not an accident.
 *
 * Every write returns the organization's FULL role list plus the new
 * `permVersion`. The client needs both: the list to re-render, and the version
 * to know that the token it holds is now stale and a re-login is coming.
 */
@Controller('admin')
@Roles('admin')
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  /** The permissions this build enforces. Code, not data (§3.2). */
  @Get('permissions')
  catalogue() {
    return this.roles.catalogue();
  }

  @Get('roles')
  async list(@CurrentScope() scope: OrgScope) {
    return this.roles.list(scope);
  }

  @Post('roles')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_roles')
  async create(@Body() dto: CreateRoleDto, @CurrentScope() scope: OrgScope) {
    return this.roles.create(scope, dto);
  }

  @Patch('roles/:id')
  @Permissions('manage_roles')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateRoleDto,
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // The actor's own role id comes from the verified token, never the body —
    // otherwise the "cannot disarm your own role" guard could be sidestepped
    // by claiming to be someone else.
    return this.roles.update(scope, id, dto, { roleId: user.roleId });
  }

  @Delete('roles/:id')
  @Permissions('manage_roles')
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.roles.remove(scope, id);
  }

  /** Move a user onto a role. Rewrites `users.role` from the role's portal. */
  @Patch('users/:id/role')
  @Permissions('manage_users')
  async assign(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { roleId?: number },
    @CurrentScope() scope: OrgScope,
  ) {
    return this.roles.assign(scope, id, Number(body?.roleId));
  }
}
