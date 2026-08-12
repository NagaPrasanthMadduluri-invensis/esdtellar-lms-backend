import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { hashPassword, verifyPassword } from '@/common/crypto/password.util';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

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
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
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
    });
  }

  async register(dto: RegisterDto): Promise<AuthResult> {
    if (await this.repository.emailExists(dto.email)) {
      throw new ConflictException('An account with this email already exists');
    }

    const created = await this.repository.createLearner({
      firstName: dto.first_name,
      lastName: dto.last_name,
      email: dto.email,
      passwordHash: hashPassword(dto.password),
      department: dto.department,
    });

    return this.issue({
      id: created.id,
      first_name: created.firstName,
      last_name: created.lastName,
      email: created.email,
      department: created.department,
      role: created.role,
      is_active: created.isActive === 1,
    });
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
    };

    return { user, token: this.tokenService.sign(claims) };
  }
}
