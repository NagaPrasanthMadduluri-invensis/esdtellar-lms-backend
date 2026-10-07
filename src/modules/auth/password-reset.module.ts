import { Module } from '@nestjs/common';

import { EmailModule } from '@/modules/email/email.module';

import { PasswordResetRepository } from './password-reset.repository';
import { PasswordResetService } from './password-reset.service';

/**
 * The one path that mints a set-password credential — the welcome link and
 * the forgot-password link alike.
 *
 * Its own module, rather than a provider of AuthModule, so that
 * OrganizationsModule can send a new organization's first admin their
 * welcome email. AuthModule imports OrganizationsModule (AuthService resolves
 * the platform org), so OrganizationsModule importing AuthModule back would
 * be a cycle. This module imports only EmailModule, which imports nothing,
 * so anything may depend on it.
 */
@Module({
  imports: [EmailModule],
  providers: [PasswordResetService, PasswordResetRepository],
  exports: [PasswordResetService],
})
export class PasswordResetModule {}
