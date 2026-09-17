import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { hashPassword, verifyPassword } from '@/common/crypto/password.util';
import { filterKnownPermissions, type RoleScope } from '@/common/permissions';
import type {
  AuthenticatedUser,
  UserRole,
} from '@/common/types/authenticated-request';

import { ActivityService } from '@/modules/activity/activity.service';

import { OrganizationsService } from '../organizations/organizations.service';
import { AuthRepository } from './auth.repository';
import type { ChangePasswordDto } from '@/modules/learner/dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
import type { UpdateProfileDto } from './dto/profile.dto';
import type { RegisterDto } from './dto/register.dto';
import { TokenService } from './token.service';

/** The user shape the client receives. Never contains the password hash. */
export interface PublicUser {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  department: string | null;
  role: UserRole;
  is_active: boolean;
  organization_id: number;
  /**
   * True when this user administers the PLATFORM organization rather than a
   * customer's.
   *
   * Exposed here so the frontend can branch its shell without probing a
   * protected endpoint and reading the 403 as a boolean — which is what it had
   * to do before, costing an extra round trip on every admin page load and
   * silently breaking if that endpoint ever moved. The platform org id itself
   * is deliberately NOT sent: the client needs the answer, not the input.
   */
  is_platform_admin: boolean;
  /**
   * The permissions this user's role holds. Sent to the client so the shell can
   * hide navigation it cannot use — cosmetic only, exactly like `middleware.js`
   * says of itself. The API is the boundary (`specs/rbac.md` §5.2).
   */
  permissions: string[];
  /** Present only on `/auth/me`, and only during a support session. */
  impersonation?: { by_name: string; organization_name: string } | null;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
  /**
   * Overrides the cookie's Max-Age for this one response. Set only for a
   * support session, whose token expires in an hour — a cookie outliving its
   * token is a browser that keeps sending a credential the server has already
   * stopped accepting, which reads to the user as "randomly signed out".
   */
  maxAgeSeconds?: number;
}

/**
 * How long a support session lasts. One hour: long enough to diagnose
 * something inside a tenant, short enough that a forgotten tab is not a
 * standing key to somebody else's account.
 */
export const IMPERSONATION_TTL_SECONDS = 60 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly repository: AuthRepository,
    private readonly organizations: OrganizationsService,
    private readonly tokenService: TokenService,
    private readonly activity: ActivityService,
  ) {}

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.repository.findActiveByEmailWithSecret(dto.email);

    // One message for "no such user" and "wrong password" — distinguishing them
    // turns the login form into an account-enumeration oracle.
    if (!user || !verifyPassword(dto.password, user.password)) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const roleContext = await this.repository.findRoleContext(
      user.id,
      user.organizationId,
    );

    return this.issue(
      {
        id: user.id,
        first_name: user.firstName,
        last_name: user.lastName,
        email: user.email,
        department: user.department,
        role: user.role,
        is_active: user.isActive === 1,
        organization_id: user.organizationId,
        is_platform_admin:
          user.role === 'admin' &&
          user.organizationId === this.organizations.getPlatformOrganizationId(),
        // Filtered against the code catalogue: a grant naming a permission this
        // build no longer enforces must not reach a claim, or a guard added
        // later under the same name would honour something nobody reviewed.
        permissions: filterKnownPermissions(roleContext.permissions),
      },
      roleContext,
    );
  }

  /**
   * Self-service signup has no way to know which organization a new learner
   * belongs to — decision 1 (`spec/multi-tenancy.md` §3.1) keeps login
   * per-email rather than per-org-subdomain, and self-service ORGANIZATION
   * signup is explicitly out of scope (§2). There is deliberately no
   * "default" org to fall back to: guessing one would put a stranger's
   * account inside a real tenant's data. An org admin adds learners within
   * their own `OrgScope` instead. This is a product decision this phase had
   * to make, not one the spec stated outright — flagged for review.
   */
  async register(_dto: RegisterDto): Promise<AuthResult> {
    throw new UnprocessableEntityException(
      'Self-service registration is unavailable. Ask your organization admin to add your account.',
    );
  }

  /** Re-reads from the database so a deactivated account loses access at once. */
  async me(userId: number, claims?: AuthenticatedUser): Promise<PublicUser> {
    const user = await this.repository.findActiveById(userId);
    if (!user) throw new NotFoundException('User not found');

    const roleContext = await this.repository.findRoleContext(
      user.id,
      user.organizationId,
    );

    return {
      permissions: filterKnownPermissions(roleContext.permissions),
      id: user.id,
      first_name: user.firstName,
      last_name: user.lastName,
      email: user.email,
      department: user.department,
      role: user.role,
      is_active: user.isActive === 1,
      organization_id: user.organizationId,
      is_platform_admin:
        user.role === 'admin' &&
        user.organizationId === this.organizations.getPlatformOrganizationId(),
      /*
       * Support-session state, read from the TOKEN rather than the row —
       * there is nothing in `users` that says this session is borrowed, and
       * there should not be: it is a property of the credential, not the
       * person.
       *
       * This is what the admin shell renders its banner from, so it has to
       * arrive on the endpoint every page already calls. A banner is not
       * decoration here: the realistic failure is a platform admin forgetting
       * whose account they are in and making a change in the wrong tenant.
       */
      impersonation: claims?.impersonatorId
        ? {
            by_name: claims.impersonatorName ?? 'Edstellar',
            organization_name:
              (await this.organizations.findOrganizationSummary(
                user.organizationId,
              ))?.name ?? 'this tenant',
          }
        : null,
    };
  }

  /**
   * Changes the CALLER's own password. Any authenticated role — this lives in
   * auth rather than under `/learner` because it is not learner work: a
   * trainer and an admin need it just as much, and the old route sat on a
   * `@Roles('learner')` controller, so the trainer portal had no way to offer
   * it at all (`specs/rbac.md` §8.3).
   *
   * `userId` and `organizationId` both come from the verified token, never the
   * body, so this cannot be pointed at somebody else's account.
   */
  async changePassword(
    userId: number,
    organizationId: number,
    dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    // Reported rule by rule, because the form renders a live strength meter
    // and "does not meet requirements" would leave it with nothing to show.
    const rules = {
      minLength: dto.newPassword.length >= 8,
      uppercase: /[A-Z]/.test(dto.newPassword),
      number: /[0-9]/.test(dto.newPassword),
      special: /[^A-Za-z0-9]/.test(dto.newPassword),
    };
    if (!Object.values(rules).every(Boolean)) {
      throw new UnprocessableEntityException({
        message: 'New password does not meet strength requirements',
        errors: {
          minLength: rules.minLength ? null : 'Must be at least 8 characters',
          uppercase: rules.uppercase
            ? null
            : 'Must contain at least one uppercase letter',
          number: rules.number ? null : 'Must contain at least one number',
          special: rules.special
            ? null
            : 'Must contain at least one special character',
        },
      });
    }

    const user = await this.repository.findActiveByIdWithSecret(
      userId,
      organizationId,
    );
    if (!user) throw new NotFoundException('User not found');

    if (!verifyPassword(dto.currentPassword, user.password)) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new UnprocessableEntityException(
        'New password must be different from your current password',
      );
    }

    await this.repository.updateOwnPassword(
      userId,
      organizationId,
      hashPassword(dto.newPassword),
    );
    return { message: 'Password updated successfully' };
  }

  /* ── My profile ──────────────────────────────────────────────────────── */

  /**
   * The caller's own record, for the profile dialog. Any authenticated role.
   *
   * Separate from `me()` because they answer different questions for
   * different callers: `me()` is identity for the shell, fetched on every
   * navigation; this is a record somebody opened deliberately, once.
   */
  async profile(userId: number) {
    const row = await this.repository.findProfile(userId);
    if (!row) throw new NotFoundException('User not found');
    return { profile: this.shapeProfile(row) };
  }

  async updateProfile(userId: number, dto: UpdateProfileDto) {
    await this.repository.updateProfile(userId, {
      firstName: dto.first_name,
      lastName: dto.last_name,
      phone: dto.phone,
      jobRole: dto.job_role,
      jobLevel: dto.job_level,
      location: dto.location,
    });
    /*
     * Re-read rather than echo the patch back.
     *
     * The response is what the dialog renders, and a patch carries only what
     * changed — echoing it would blank every field the form did not send. The
     * name claims in the caller's TOKEN are now stale too, which is stated in
     * the controller's docblock rather than fixed by re-minting one: a
     * profile edit is not worth invalidating a session over, and the shell
     * catches up on the next sign-in.
     */
    return this.profile(userId);
  }

  private shapeProfile(row: {
    id: number; first_name: string; last_name: string; email: string;
    role: UserRole; role_label: string | null; department: string | null;
    employee_id: string | null; job_role: string | null;
    job_level: string | null; location: string | null; phone: string | null;
    is_active: number; organization_id: number; organization_name: string;
    created_at: string; last_active: string | null;
  }) {
    return {
      id: row.id,
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      role: row.role,
      // The RBAC role's label, not `users.role` — a Manager rides in the
      // learner portal and would otherwise be told they are a Learner.
      role_label: row.role_label,
      department: row.department,
      employee_id: row.employee_id,
      job_role: row.job_role,
      job_level: row.job_level,
      location: row.location,
      phone: row.phone,
      is_active: row.is_active === 1,
      organization_id: row.organization_id,
      organization_name: row.organization_name,
      // The dialog's "Change password" link differs per portal and there is
      // no shared route, so it needs to know which shell it is in.
      is_platform_admin:
        row.role === 'admin' &&
        row.organization_id === this.organizations.getPlatformOrganizationId(),
      joined_at: row.created_at,
      last_active: row.last_active,
    };
  }

  /* ── Support sessions ────────────────────────────────────────────────── */

  /**
   * Mint a token that puts a PLATFORM ADMIN inside a tenant's account.
   *
   * The token carries the tenant's owner-admin identity, so every screen and
   * every query behaves exactly as if that person had signed in — nothing
   * downstream needs to know this happened, which is what keeps the blast
   * radius of the feature at one method instead of spread across the codebase.
   *
   * What makes it accountable rather than a back door:
   *
   *   1. **Only `@PlatformAdmin()` reaches it.** The caller's own token is
   *      re-checked here too, not just by the guard — being a platform admin
   *      is the entire authorisation for becoming somebody else.
   *   2. **`impersonatorId` / `impersonatorName` ride along**, so the shell
   *      can say whose account this is, the platform routes can refuse, and
   *      exiting has something to return to.
   *   3. **It expires in an hour, not a week.**
   *   4. **The tenant is told.** An activity entry is written into THEIR org,
   *      so it shows in their own Recent Activity — support entering a
   *      customer's account is not something to keep on our side of the wall.
   *      Best-effort (§8.4): it must not be able to fail the sign-in, and it
   *      is a product feature rather than an audit trail, which is why the
   *      server log below is written unconditionally as well.
   *
   * Refusals: the platform organization itself (there is nothing to
   * impersonate — that is where they already are), an organization with no
   * active admin-portal account, and a token that is already a support
   * session (exit first, or two hops would lose the way back).
   */
  async impersonate(
    actor: AuthenticatedUser,
    organizationId: number,
  ): Promise<AuthResult & { organization: { id: number; name: string } }> {
    if (actor.impersonatorId) {
      throw new ForbiddenException(
        'You are already signed in to a tenant. Exit that session first.',
      );
    }
    if (organizationId === this.organizations.getPlatformOrganizationId()) {
      throw new UnprocessableEntityException(
        'That is the platform organization — it is where you already are.',
      );
    }

    const organization = await this.organizations.scopeFor(organizationId);
    const summary =
      await this.organizations.findOrganizationSummary(organizationId);
    const target =
      await this.repository.findOwnerAdminForOrganization(organizationId);

    if (!target) {
      throw new UnprocessableEntityException(
        'That organization has no active admin account to sign in as. ' +
          'Create one first.',
      );
    }

    const roleContext = await this.repository.findRoleContext(
      target.id,
      target.organization_id,
    );

    const actorName =
      `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || actor.email;

    const user: PublicUser = {
      id: target.id,
      first_name: target.first_name,
      last_name: target.last_name,
      email: target.email,
      department: target.department,
      role: target.role,
      is_active: target.is_active === 1,
      organization_id: target.organization_id,
      // False by construction: the platform org is refused above, so the
      // account being assumed is never a platform admin. A support session
      // therefore cannot reach the platform console at all.
      is_platform_admin: false,
      permissions: filterKnownPermissions(roleContext.permissions),
    };

    const result = this.issue(user, roleContext, {
      impersonatorId: actor.userId,
      impersonatorName: actorName,
      ttlSeconds: IMPERSONATION_TTL_SECONDS,
    });

    this.logger.warn(
      `Support session STARTED: platform admin ${actor.userId} (${actor.email}) ` +
        `signed in to organization ${organizationId} as user ${target.id} ` +
        `(${target.email})`,
    );

    void this.activity.record(organization, {
      type: 'support_session_started',
      detail:
        `${actorName} (Edstellar) opened a support session as ` +
        `${target.first_name} ${target.last_name}.`,
      // The actor recorded is the assumed account, because that is whose name
      // will sit against anything done next. The DETAIL names the real person
      // — the two together are the honest version, and the server log above is
      // the one that does not depend on a best-effort write.
      actor: {
        userId: target.id,
        firstName: target.first_name,
        lastName: target.last_name,
      },
      subjectType: 'user',
      subjectId: target.id,
    });

    return {
      ...result,
      organization: { id: organizationId, name: summary?.name ?? 'Tenant' },
    };
  }

  /**
   * End a support session and hand the platform admin their own token back.
   *
   * `impersonatorId` says who to return to, but the claim is NOT the
   * authorisation: the row is re-read and re-checked to still be an active
   * platform admin. Otherwise a support token would keep working as a way
   * back into the platform console after that account had been demoted or
   * deactivated — the token outliving the permission is exactly the failure
   * `permVersion` exists to prevent everywhere else.
   */
  async exitImpersonation(actor: AuthenticatedUser): Promise<AuthResult> {
    if (!actor.impersonatorId) {
      throw new ForbiddenException('This is not a support session.');
    }

    const platformAdmin = await this.repository.findActiveById(
      actor.impersonatorId,
    );
    if (
      !platformAdmin ||
      platformAdmin.role !== 'admin' ||
      platformAdmin.organizationId !==
        this.organizations.getPlatformOrganizationId()
    ) {
      throw new ForbiddenException(
        'That platform account is no longer active. Sign in again.',
      );
    }

    const roleContext = await this.repository.findRoleContext(
      platformAdmin.id,
      platformAdmin.organizationId,
    );

    this.logger.warn(
      `Support session ENDED: platform admin ${platformAdmin.id} ` +
        `(${platformAdmin.email}) left organization ${actor.organizationId}`,
    );

    return this.issue(
      {
        id: platformAdmin.id,
        first_name: platformAdmin.firstName,
        last_name: platformAdmin.lastName,
        email: platformAdmin.email,
        department: platformAdmin.department,
        role: platformAdmin.role,
        is_active: platformAdmin.isActive === 1,
        organization_id: platformAdmin.organizationId,
        is_platform_admin: true,
        permissions: filterKnownPermissions(roleContext.permissions),
      },
      roleContext,
    );
  }

  private issue(
    user: PublicUser,
    roleContext: {
      roleId: number | null;
      scope: RoleScope;
      permVersion: number;
      userPermVersion: number;
    },
    support?: {
      impersonatorId: number;
      impersonatorName: string;
      ttlSeconds: number;
    },
  ): AuthResult {
    const claims: AuthenticatedUser = {
      userId: user.id,
      role: user.role,
      email: user.email,
      // Carried in the token so the server-rendered shell can show the user's
      // name without a second round trip on every navigation.
      firstName: user.first_name,
      lastName: user.last_name,
      organizationId: user.organization_id,
      roleId: roleContext.roleId,
      scope: roleContext.scope,
      permissions: filterKnownPermissions(user.permissions),
      // The version this token is valid for. Any write to roles or
      // role_permissions bumps the organization's value, and AuthGuard then
      // rejects this token — which is what makes a permission change sign the
      // organization out (`specs/rbac.md` §3.6).
      permVersion: roleContext.permVersion,
      userPermVersion: roleContext.userPermVersion,
      ...(support
        ? {
            impersonatorId: support.impersonatorId,
            impersonatorName: support.impersonatorName,
          }
        : {}),
    };

    return {
      user,
      token: this.tokenService.sign(claims, support?.ttlSeconds),
      maxAgeSeconds: support?.ttlSeconds,
    };
  }
}
