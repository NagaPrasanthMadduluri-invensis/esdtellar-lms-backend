import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';
import { OrgOptionsModule } from '@/modules/org-options/org-options.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

/**
 * TokenService is exported because the global AuthGuard depends on it to verify
 * incoming requests.
 */
@Module({
  imports: [OrganizationsModule, ActivityModule, OrgOptionsModule],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, TokenService],
  exports: [TokenService, AuthRepository],
})
export class AuthModule {}
