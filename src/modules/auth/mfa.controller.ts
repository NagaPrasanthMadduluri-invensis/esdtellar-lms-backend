import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { MfaService } from './mfa.service';
import { MfaCodeDto } from './dto/mfa.dto';

/**
 * MFA enrolment — admin accounts only (0058).
 *
 * `@Roles('admin')` covers tenant and platform admins alike, which is the scope
 * the product chose for MFA. The login second-factor step is NOT here — it is
 * `POST /auth/mfa/verify` on the public auth controller, because at that point
 * the caller has no session yet, only a challenge token.
 *
 * Identity is always the caller's own (`@CurrentUser().userId`); no route takes
 * a user id, so one admin can never enrol or disable another.
 */
@Controller('auth/mfa')
@Roles('admin')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  /** Whether the caller has MFA enrolled / enabled, for the profile UI. */
  @Get('status')
  async status(@CurrentUser() user: AuthenticatedUser) {
    const status = await this.mfa.status(user.userId);
    return { ...status, configured: this.mfa.isConfigured() };
  }

  /** Step 1: begin enrolment — returns the secret, otpauth URL and QR image. */
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  async setup(@CurrentUser() user: AuthenticatedUser) {
    return this.mfa.setup(user.userId, user.email);
  }

  /** Step 2: confirm a first code, activate, and return one-time recovery codes. */
  @Post('enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaCodeDto,
  ) {
    return this.mfa.enable(user.userId, dto.code);
  }

  /** Turn MFA off, after proving a current code or a recovery code. */
  @Post('disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaCodeDto,
  ) {
    return this.mfa.disable(user.userId, dto.code);
  }
}
