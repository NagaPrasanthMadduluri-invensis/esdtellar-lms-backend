import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { AllowBeforeMfa, CurrentUser } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { RateLimit } from '@/common/rate-limit/rate-limit';

import { MfaService } from './mfa.service';
import { MfaCodeDto, MfaSetupDto } from './dto/mfa.dto';

/**
 * Two-step sign-in enrolment (0058, widened 2026-11-18).
 *
 * MANDATORY for admin-portal accounts (tenant and platform admins): they are
 * held at the setup page until it is on (MfaEnrolmentGuard), and may not turn
 * it off. OPTIONAL for everyone else (learners, managers, trainers), from My
 * Profile. The login second-factor step is NOT here — it is
 * `POST /auth/mfa/verify` on the public auth controller, because at that point
 * the caller has no session yet, only a challenge token.
 *
 * Identity is always the caller's own (`@CurrentUser().userId`); no route takes
 * a user id, so one admin can never enrol or disable another.
 */
@Controller('auth/mfa')
@AllowBeforeMfa()
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  /** Whether the caller has MFA enrolled / enabled, for the profile UI. */
  @Get('status')
  async status(@CurrentUser() user: AuthenticatedUser) {
    const status = await this.mfa.status(user.userId);
    return {
      ...status,
      configured: this.mfa.canEnrol(),
      // Admins cannot opt out; the profile panel hides "turn off" on this.
      required: user.role === 'admin',
    };
  }

  /** Step 1: begin enrolment — returns the secret, otpauth URL and QR image. */
  @Post('setup')
  @HttpCode(HttpStatus.OK)
  async setup(@CurrentUser() user: AuthenticatedUser, @Body() dto: MfaSetupDto) {
    return this.mfa.setup(user.userId, user.email, dto.method ?? 'totp');
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

  /**
   * Email a code to a signed-in person whose method is email (0069), so they
   * can prove it when turning two-step sign-in off. Same caps as at sign-in.
   */
  @Post('email-code')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ name: 'mfa-email-code', by: 'user', limit: 5, windowSeconds: 900,
    message: 'Too many code requests.' })
  async emailCode(@CurrentUser() user: AuthenticatedUser) {
    if ((await this.mfa.methodFor(user.userId)) !== 'email') {
      throw new ForbiddenException('This account uses an authenticator app, not email codes.');
    }
    return { sent_to: await this.mfa.startLoginChallenge(user.userId) };
  }

  /** Turn two-step sign-in off, after proving a current code or a recovery code. */
  @Post('disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MfaCodeDto,
  ) {
    if (user.role === 'admin') {
      throw new ForbiddenException('Two-step sign-in is required for admin accounts and cannot be turned off.');
    }
    return this.mfa.disable(user.userId, dto.code);
  }
}
