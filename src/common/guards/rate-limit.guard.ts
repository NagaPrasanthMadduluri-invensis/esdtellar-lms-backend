import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';

import {
  DEFAULT_AUTHENTICATED_RULE,
  DEFAULT_PUBLIC_RULE,
  RATE_LIMIT_KEY,
  RateLimitStore,
  clientIp,
  type RateLimitRule,
} from '../rate-limit/rate-limit';
import type { AuthenticatedRequest } from '../types/authenticated-request';
import { AlertsService } from '@/modules/alerts/alerts.service';

/**
 * Global request rate limit (see `common/rate-limit/rate-limit.ts` for why the
 * keys are what they are).
 *
 * Registered directly AFTER AuthGuard: it needs `request.user` to count a
 * signed-in caller per user, and a request AuthGuard has already refused with
 * a 401 never spends anybody's budget. Before every other guard, so a flood
 * of forbidden calls is still throttled.
 *
 * A 429 carries `Retry-After`, and its sentence says when to try again. The
 * audit middleware records the refusal like any other response.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  /** Exposed for tests; one store per process. */
  readonly store = new RateLimitStore();

  constructor(
    private readonly reflector: Reflector,
    /** Sign-in limits tripping is posted to Cliq (§10.50). Optional for tests. */
    @Optional() private readonly alerts?: AlertsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const declared = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    const rules =
      declared && declared.length
        ? declared
        : [request.user ? DEFAULT_AUTHENTICATED_RULE : DEFAULT_PUBLIC_RULE];

    const route = `${request.method} ${request.route?.path ?? request.path}`;
    for (const rule of rules) {
      const subject = this.subjectFor(rule, request);
      const result = this.store.hit(
        `${rule.name}|${route}|${subject}`,
        rule.limit,
        rule.windowSeconds * 1000,
      );
      if (!result.allowed) {
        const response = context.switchToHttp().getResponse<Response>();
        response.setHeader('Retry-After', String(result.retryAfterSeconds));
        this.logger.warn(
          `Rate limit "${rule.name}" hit on ${route} by ${rule.by}=${subject} ` +
            `(${rule.limit}/${rule.windowSeconds}s).`,
        );
        // The subject (an IP and possibly an email) stays in this local log;
        // only the rule and the route go to Cliq.
        this.alerts?.recordRateLimit(rule.name, route);
        throw new HttpException(
          { message: this.messageFor(rule, result.retryAfterSeconds) },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }

  private subjectFor(rule: RateLimitRule, request: AuthenticatedRequest): string {
    const ip = clientIp(request as never);
    if (rule.by === 'user') {
      // A user rule on a public route falls back to the address rather than
      // putting every anonymous caller in one shared bucket.
      return request.user ? `u${request.user.userId}` : `ip:${ip}`;
    }
    if (rule.by === 'ip+email') {
      const body = (request.body ?? {}) as { email?: unknown };
      const email =
        typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      return `ip:${ip}|e:${email}`;
    }
    return `ip:${ip}`;
  }

  private messageFor(rule: RateLimitRule, retryAfter: number): string {
    const wait =
      retryAfter >= 90
        ? `${Math.ceil(retryAfter / 60)} minutes`
        : `${retryAfter} seconds`;
    return `${rule.message ?? 'Too many requests.'} Please try again in ${wait}.`;
  }
}
