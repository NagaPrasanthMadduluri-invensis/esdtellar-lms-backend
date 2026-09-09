import {
  Injectable,
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

import { OrganizationsService } from '../organizations/organizations.service';
import { AuthRepository } from './auth.repository';
import type { ChangePasswordDto } from '@/modules/learner/dto/change-password.dto';
import type { LoginDto } from './dto/login.dto';
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
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly organizations: OrganizationsService,
    private readonly tokenService: TokenService,
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
  async me(userId: number): Promise<PublicUser> {
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

  private issue(
    user: PublicUser,
    roleContext: {
      roleId: number | null;
      scope: RoleScope;
      permVersion: number;
      userPermVersion: number;
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
    };

    return { user, token: this.tokenService.sign(claims) };
  }
}
