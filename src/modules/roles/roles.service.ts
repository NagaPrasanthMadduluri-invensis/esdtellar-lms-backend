import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  filterKnownPermissions,
  isPermission,
  PERMISSION_CATALOGUE,
  type Permission,
} from '@/common/permissions';
import type { OrgScope } from '@/database/org-scope';

import type { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { SeatsService } from '@/modules/seats/seats.service';

import { RolesRepository } from './roles.repository';

/**
 * Roles and permissions for one organization — `specs/rbac.md` §3.3, §3.8.
 *
 * Two rules run through every method here:
 *
 *   1. A permission must exist in the CODE catalogue. The database stores which
 *      roles hold what, never what may be held, so an unknown key is a 422 and
 *      not a row. Without this the old mock's failure survives: an admin could
 *      invent `delete_everything` and it would enforce nothing.
 *   2. Every write bumps the organization's `perm_version`, which is what
 *      signs that organization out and makes the change take effect on the
 *      next request rather than in seven days.
 *
 * There is no transaction around these writes, deliberately: wrapping them
 * would mean the repository hosting the lockout guards, which §3.1 forbids. So
 * every guard is asked BEFORE the first write instead, and nothing needs
 * undoing. The bump comes last, so a failure part-way leaves tokens valid
 * against the old permissions rather than against a half-applied set.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly repository: RolesRepository,
    /**
     * A role change can CREATE a seat holder. Moving somebody onto a
     * learner-portal role is the same commercial event as creating a learner,
     * and until this dependency existed it was the one way past the cap.
     */
    private readonly seats: SeatsService,
  ) {}

  /**
   * Resolve a role the caller named by id, for putting somebody on it.
   *
   * 404 rather than 422 when it belongs to another organization, the same
   * choice `assign` makes: a role id from another tenant must not be
   * distinguishable from one that does not exist.
   */
  async roleForAssignment(scope: OrgScope, roleId: number) {
    const role = await this.repository.findById(scope, roleId);
    if (!role) throw new NotFoundException('Role not found');
    return {
      id: Number(role.id),
      key: role.key,
      label: role.label,
      portal: role.portal,
    };
  }

  /** The catalogue this build enforces. Code, not data — see §3.2. */
  catalogue() {
    return { permissions: PERMISSION_CATALOGUE };
  }

  /**
   * One role in this organization, or 404.
   *
   * Public because creating a user has to know the role's `portal` BEFORE the
   * insert (`PlatformRolesService.createUser`) — `users.role` is derived from
   * it, and a role id that does not belong to this organization has to fail
   * before anything is written rather than after.
   *
   * 404 and not 422 for a foreign-organization id, matching `assign()` below:
   * whether a role exists in another tenant is not something this caller may
   * learn.
   */
  async requireRole(scope: OrgScope, roleId: number) {
    const role = await this.repository.findById(scope, roleId);
    if (!role) throw new NotFoundException('Role not found');
    return {
      id: Number(role.id),
      key: role.key,
      label: role.label,
      portal: role.portal,
      scope: role.scope,
      isSystem: role.is_system,
    };
  }

  /**
   * The organization's role for a given key, or 422 naming the problem.
   *
   * `UsersService.create` needs the `learner` role's id because `role_id` is
   * NOT NULL, and an INSERT has to supply it. 422 rather than 404 because the
   * caller did not ask for this role by id — the organization is in a state
   * that cannot accept a new learner, and the message has to say which state,
   * or the admin sees a bare failure on an unrelated form.
   *
   * `is_system` and lockout guard 4 mean the seeded `learner` role is very
   * hard to remove, so this is a defensive branch rather than an expected one.
   */
  async roleByKey(scope: OrgScope, key: string) {
    const role = await this.repository.findByKey(scope, key);
    if (!role) {
      throw new UnprocessableEntityException(
        `This organization has no "${key}" role, so a user cannot be created ` +
          'on it. Create one on the Roles screen first.',
      );
    }
    return {
      id: Number(role.id),
      key: role.key,
      label: role.label,
      portal: role.portal,
    };
  }

  async list(scope: OrgScope) {
    const rows = await this.repository.list(scope);
    return {
      roles: rows.map((r) => ({
        id: Number(r.id),
        key: r.key,
        label: r.label,
        portal: r.portal,
        scope: r.scope,
        isSystem: r.is_system,
        users: Number(r.users ?? 0),
        // Filtered so a grant naming a permission this build no longer has
        // cannot appear ticked on a screen that could not enforce it.
        permissions: filterKnownPermissions(r.permissions ?? []),
      })),
    };
  }

  async create(scope: OrgScope, dto: CreateRoleDto) {
    const permissions = this.assertKnown(dto.permissions ?? []);

    if (await this.repository.keyExists(scope, dto.key)) {
      throw new ConflictException(`A role with key "${dto.key}" already exists`);
    }

    const roleId = await this.repository.create(scope, {
      key: dto.key,
      label: dto.label,
      portal: dto.portal,
      scope: dto.scope ?? 'self',
    });
    await this.repository.replacePermissions(scope, roleId, permissions);
    const permVersion = await this.repository.bumpPermVersion(scope);

    return { ...(await this.list(scope)), permVersion };
  }

  async update(scope: OrgScope, roleId: number, dto: UpdateRoleDto, actor: { roleId: number | null }) {
    const role = await this.repository.findById(scope, roleId);
    if (!role) throw new NotFoundException('Role not found');

    const permissions =
      dto.permissions === undefined ? null : this.assertKnown(dto.permissions);

    /**
     * Guard 3 (§3.8): you cannot remove `manage_roles` from your OWN role.
     *
     * Checked before anything is written, and before the org-wide guard below,
     * because this is the mistake an admin actually makes — the org-wide check
     * would let it through whenever a second admin role exists, and the person
     * who pressed Save would still have locked themselves out.
     */
    if (
      permissions !== null &&
      actor.roleId === roleId &&
      !permissions.includes('manage_roles')
    ) {
      throw new UnprocessableEntityException(
        'You cannot remove "Manage roles and permissions" from your own role — ' +
          'you would not be able to put it back.',
      );
    }

    /**
     * Guards 1 and 2 (§3.8), asked BEFORE anything is written.
     *
     * The obvious shape is "write, then check, then roll back" — but these
     * writes are not in a transaction (the repository must not host business
     * rules, §3.1), so a failed check afterwards would leave the change
     * applied. Asking first makes the guard sound without one: if this role is
     * about to lose `manage_roles`, some OTHER admin-portal role with an active
     * user has to hold it already.
     */
    if (
      permissions !== null &&
      role.portal === 'admin' &&
      !permissions.includes('manage_roles')
    ) {
      const others = await this.repository.administeringRolesExcept(scope, roleId);
      if (others.length === 0) {
        throw new UnprocessableEntityException(
          'This would leave the organization with no administrator: no other ' +
            'admin-portal role holding "Manage roles and permissions" has an ' +
            'active user.',
        );
      }
    }

    await this.repository.updateMeta(scope, roleId, {
      label: dto.label,
      scope: dto.scope,
    });
    if (permissions !== null) {
      await this.repository.replacePermissions(scope, roleId, permissions);
    }

    const permVersion = await this.repository.bumpPermVersion(scope);

    return { ...(await this.list(scope)), permVersion };
  }

  async remove(scope: OrgScope, roleId: number) {
    const role = await this.repository.findById(scope, roleId);
    if (!role) throw new NotFoundException('Role not found');

    // Guard 4 (§3.8). The composite FK has no ON DELETE SET NULL, so this is
    // also structural — but a 422 naming the count is a better answer than a
    // constraint violation surfacing as a 500.
    if (Number(role.users) > 0) {
      throw new UnprocessableEntityException(
        `"${role.label}" is held by ${role.users} user(s). Move them to another ` +
          'role first.',
      );
    }
    if (role.is_system) {
      throw new UnprocessableEntityException(
        `"${role.label}" is a system role and cannot be deleted. You can rename ` +
          'it or change what it may do.',
      );
    }

    // A role with no users cannot be the one keeping the org administrable
    // (guard 2 requires an active user), so deleting it is always safe on that
    // axis — the users check above is what does the work.
    await this.repository.remove(scope, roleId);
    const permVersion = await this.repository.bumpPermVersion(scope);

    return { ...(await this.list(scope)), permVersion };
  }

  /**
   * Moves a user onto one of this organization's roles.
   *
   * `users.role` is rewritten from the role's `portal` here, which is what
   * keeps the portal selector and the role in agreement (§3.4) — and what
   * makes assigning a trainer role actually change which portal that person
   * lands in.
   */
  async assign(scope: OrgScope, userId: number, roleId: number) {
    const role = await this.repository.findById(scope, roleId);
    // 404 rather than 422: a role id from another organization must not be
    // distinguishable from one that does not exist.
    if (!role) throw new NotFoundException('Role not found');

    const current = await this.repository.findUserRole(scope, userId);
    if (!current) throw new NotFoundException('User not found');

    // Nothing to do, and saying so beats a pointless perm_version bump that
    // would sign the person out for no change (§3.6).
    if (Number(current.role_id) === Number(role.id)) {
      return {
        ok: true,
        unchanged: true,
        role: { id: Number(role.id), key: role.key, portal: role.portal },
      };
    }

    /*
     * MOVING ONTO A LEARNER ROLE COSTS A SEAT, and this used to be the hole
     * in the cap. A seat is an active learner (`0028`), so an organization at
     * its limit could convert a trainer or an admin into a learner and go
     * past a number `UsersService.create` refuses to let them past. A limit
     * enforced on one path and not the other is worse than none: it tells an
     * admin they are capped while leaving a door open beside the sign.
     *
     * Only when they are ACTIVE and not already a learner — deactivated
     * people hold no seat, and a learner staying a learner frees and takes
     * the same one.
     */
    const becomesLearner =
      role.portal === 'learner' && current.role !== 'learner';
    if (becomesLearner && current.is_active === 1) {
      await this.seats.assertSeatAvailable(scope);
    }

    /*
     * AN ORGANIZATION MUST KEEP AN ADMIN. Moving the last active admin-portal
     * account onto another portal leaves a tenant nobody can administer —
     * the state the tenant directory renders as a warning and the support
     * session refuses to enter. Provisioning guarantees an org is CREATED
     * with an admin (§10.17); this is what stops one being edited away.
     */
    if (current.role === 'admin' && role.portal !== 'admin') {
      const remaining = await this.repository.countActiveAdmins(scope, userId);
      if (remaining === 0) {
        throw new ConflictException(
          'This is the only active admin in the organization. Give somebody ' +
            'else an admin role first — an organization with no admin cannot ' +
            'be signed into or managed.',
        );
      }
    }

    await this.repository.assignRole(scope, userId, roleId, role.portal);

    // Only THIS user's token becomes stale, so only their version moves.
    // Bumping the organization's would sign everyone out every time an admin
    // added an employee — routine administration should not do that (§3.6).
    await this.repository.bumpUserPermVersion(scope, userId);

    return {
      ok: true,
      role: { id: Number(role.id), key: role.key, portal: role.portal },
    };
  }

  private assertKnown(permissions: readonly string[]): Permission[] {
    const unknown = permissions.filter((p) => !isPermission(p));
    if (unknown.length > 0) {
      throw new UnprocessableEntityException(
        `Unknown permission(s): ${unknown.join(', ')}. A permission only means ` +
          'something because a guard checks it, so it has to exist in the code ' +
          'catalogue first.',
      );
    }
    return filterKnownPermissions(permissions);
  }
}
