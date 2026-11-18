import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { MfaService } from '@/modules/auth/mfa.service';

import { ALLOW_BEFORE_MFA_KEY, IS_PUBLIC_KEY } from '../decorators';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/** How long a confirmed enrolment is remembered, so admins cost no extra query per request. */
const ENROLLED_CACHE_MS = 60_000;

/**
 * Two-step sign-in is MANDATORY for admin-portal accounts (2026-11-18).
 *
 * The client holds an un-enrolled admin at /mfa-setup, but a screen is not a
 * control: with only the redirect, someone holding a stolen admin password
 * could skip the page and call the API directly. So this guard refuses every
 * route for an admin who has not switched two-step sign-in on, except the
 * handful marked `@AllowBeforeMfa()` that the setup page itself needs.
 *
 * Not applied:
 * - to learners, managers and trainers: optional for them;
 * - inside a support session: the platform admin already passed their own
 *   second factor to get there;
 * - when MFA_ENCRYPTION_KEY is not set: nobody could enrol, so enforcing it
 *   would lock every admin out. A warning is logged instead.
 *
 * Registered after AuthGuard and RateLimitGuard, before the role and
 * permission guards, so an un-enrolled admin hears "set up two-step sign-in"
 * rather than a permission error that would send them looking elsewhere.
 */
@Injectable()
export class MfaEnrolmentGuard implements CanActivate {
  private readonly logger = new Logger(MfaEnrolmentGuard.name);
  private readonly enrolledUntil = new Map<number, number>();
  private warnedUnconfigured = false;

  constructor(
    private readonly reflector: Reflector,
    private readonly mfa: MfaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_BEFORE_MFA_KEY, targets)) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user || user.role !== 'admin' || user.impersonatorId) return true;

    if (!this.mfa.canEnrol()) {
      if (!this.warnedUnconfigured) {
        this.logger.warn('Two-step sign-in is NOT enforced for admins: neither MFA_ENCRYPTION_KEY nor email is configured.');
        this.warnedUnconfigured = true;
      }
      return true;
    }

    const now = Date.now();
    if ((this.enrolledUntil.get(user.userId) ?? 0) > now) return true;
    if (await this.mfa.isEnabledForLogin(user.userId)) {
      this.enrolledUntil.set(user.userId, now + ENROLLED_CACHE_MS);
      return true;
    }
    throw new ForbiddenException(
      'Set up two-step sign-in to continue. It is required for admin accounts.',
    );
  }
}
