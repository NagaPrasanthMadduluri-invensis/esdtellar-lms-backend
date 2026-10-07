import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';
import { EmailModule } from '@/modules/email/email.module';
import { OrgOptionsModule } from '@/modules/org-options/org-options.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';
import { TokenService } from './token.service';

/**
 * TokenService is exported because the global AuthGuard depends on it to verify
 * incoming requests.
 */
@Module({
  imports: [OrganizationsModule, ActivityModule, OrgOptionsModule, EmailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    TokenService,
    PasswordResetService,
    PasswordResetRepository,
  ],
  // PasswordResetService is exported so UsersService can send the welcome
  // email: it mints the same one-time token, and a second implementation
  // would be a second way to create a credential.
  exports: [TokenService, AuthRepository, PasswordResetService],
})
export class AuthModule {}
