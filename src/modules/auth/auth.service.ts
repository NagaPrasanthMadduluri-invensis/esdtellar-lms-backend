import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { verifyPassword } from '@/common/crypto/password.util';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { OrganizationsService } from '../organizations/organizations.service';
import { AuthRepository } from './auth.repository';
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
  role: 'admin' | 'learner';
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

    return this.issue({
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
    });
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

    return {
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

  private issue(user: PublicUser): AuthResult {
    const claims: AuthenticatedUser = {
      userId: user.id,
      role: user.role,
      email: user.email,
      // Carried in the token so the server-rendered shell can show the user's
      // name without a second round trip on every navigation.
      firstName: user.first_name,
      lastName: user.last_name,
      organizationId: user.organization_id,
    };

    return { user, token: this.tokenService.sign(claims) };
  }
}
