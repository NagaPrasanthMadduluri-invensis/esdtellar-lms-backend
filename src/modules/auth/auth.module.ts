import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';
import { EmailModule } from '@/modules/email/email.module';
import { MediaModule } from '@/modules/media/media.module';
import { OrgOptionsModule } from '@/modules/org-options/org-options.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { MfaController } from './mfa.controller';
import { MfaRepository } from './mfa.repository';
import { MfaService } from './mfa.service';
import { PasswordResetModule } from './password-reset.module';
import { TokenService } from './token.service';

/**
 * TokenService is exported because the global AuthGuard depends on it to verify
 * incoming requests.
 */
@Module({
  imports: [OrganizationsModule, ActivityModule, OrgOptionsModule, EmailModule, PasswordResetModule, MediaModule],
  controllers: [AuthController, MfaController],
  providers: [
    AuthService,
    AuthRepository,
    TokenService,
    MfaService,
    MfaRepository,
  ],
  // PasswordResetService is exported so UsersService can send the welcome
  // email: it mints the same one-time token, and a second implementation
  // would be a second way to create a credential.
  // PasswordResetModule is RE-exported so existing importers of AuthModule
  // (UsersModule, the worker) keep receiving PasswordResetService unchanged.
  exports: [TokenService, AuthRepository, PasswordResetModule],
})
export class AuthModule {}
