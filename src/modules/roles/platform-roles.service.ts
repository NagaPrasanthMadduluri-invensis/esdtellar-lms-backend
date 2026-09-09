import { Injectable, NotFoundException } from '@nestjs/common';

import { OrganizationsService } from '@/modules/organizations/organizations.service';

import type { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import type { CreateOrganizationUserDto } from './dto/platform-user.dto';
import { RolesService } from './roles.service';

/**
 * Delegated administration — a platform super-admin managing one
 * organization's roles and creating users on them. `specs/rbac.md` §3.9.
 *
 * This is a THIN layer on purpose. Every rule about what a role may hold, and
 * every lockout guard, lives in `RolesService` and is not restated here — the
 * whole point of the design is that a super-admin ticking a box goes through
 * exactly the same code path as that organization's own admin, with a
 * different scope. If this file ever grows a rule of its own, the two
 * audiences have begun to diverge and one of them is wrong.
 *
 * What DOES live here is the one thing that differs: resolving the target
 * organization into an `OrgScope`. That happens in
 * `OrganizationsService.scopeFor()`, whose docblock explains why it is safe
 * and states the invariant this class has to keep — every route reaching it is
 * behind `@PlatformAdmin()`.
 */
@Injectable()
export class PlatformRolesService {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly roles: RolesService,
  ) {}

  /**
   * The organization's roles WITH their permissions, plus the code catalogue.
   *
   * Both in one response because the caller needs both to render a matrix, and
   * the catalogue is small and static — a second round trip for it would be
   * two requests to draw one table.
   */
  async list(organizationId: number) {
    const scope = await this.organizations.scopeFor(organizationId);
    const [{ permissions }, { roles }] = [
      this.roles.catalogue(),
      await this.roles.list(scope),
    ];
    return { permissions, roles };
  }

  async create(organizationId: number, dto: CreateRoleDto) {
    const scope = await this.organizations.scopeFor(organizationId);
    return this.roles.create(scope, dto);
  }

  /**
   * `actorRoleId` is the super-admin's OWN role id, from their verified token,
   * and it is passed straight through rather than nulled out.
   *
   * That looks like it might mis-fire — the actor is not in the organization
   * being edited — but it is exactly right in both directions. `roles.id` is a
   * global sequence, so their platform-org role id can never equal a role id
   * in another organization, and guard 3 ("you cannot strip `manage_roles`
   * from your own role") is simply inert there. When the organization being
   * edited IS the platform organization, the ids can match and the guard fires
   * and protects them. Nulling it would have quietly removed that protection
   * for the one case where it matters.
   */
  async update(
    organizationId: number,
    roleId: number,
    dto: UpdateRoleDto,
    actorRoleId: number | null,
  ) {
    const scope = await this.organizations.scopeFor(organizationId);
    return this.roles.update(scope, roleId, dto, { roleId: actorRoleId });
  }

  async remove(organizationId: number, roleId: number) {
    const scope = await this.organizations.scopeFor(organizationId);
    return this.roles.remove(scope, roleId);
  }

  /**
   * Creates a user in the organization, on one of its roles.
   *
   * Create-then-assign, in that order, for two reasons:
   *
   *   - the role is resolved BEFORE the insert, so a bad `roleId` is a 404
   *     with nothing written. Inserting first would leave a user carrying
   *     whatever role the insert guessed;
   *   - `RolesService.assign` then runs as the single writer that MOVES a user
   *     onto a role (§8.3) and bumps that ONE user's `perm_version`. It is
   *     redundant for a user created seconds ago — nobody holds a token for
   *     them — but going through it is what keeps the number of methods that
   *     write `role_id` at one, and costs a single UPDATE.
   */
  async createUser(organizationId: number, dto: CreateOrganizationUserDto) {
    const scope = await this.organizations.scopeFor(organizationId);

    const role = await this.roles.requireRole(scope, dto.roleId);

    const { user } = await this.organizations.createOrganizationUser(
      organizationId,
      {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        password: dto.password,
        roleId: role.id,
        // Never from the request — `users.role` is the portal selector and is
        // always derived from the resolved role (§3.4).
        role: role.portal,
        department: dto.department ?? null,
        jobRole: dto.jobRole ?? null,
      },
    );

    if (!user) throw new NotFoundException('User could not be created');

    await this.roles.assign(scope, user.id, role.id);

    return {
      user: {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        roleId: user.roleId,
        isActive: user.isActive === 1,
      },
      role: { id: role.id, key: role.key, label: role.label, portal: role.portal },
    };
  }
}
