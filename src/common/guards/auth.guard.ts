import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { TokenService } from '@/modules/auth/token.service';

import { IS_PUBLIC_KEY } from '../decorators';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Registered globally in AppModule, so every route is authenticated unless it
 * carries @Public().
 *
 * Token source, in order:
 *   1. The HttpOnly `lms_token` cookie (how the browser authenticates).
 *   2. An `Authorization: Bearer` header (server-to-server callers and the
 *      legacy Next.js routes during the migration).
 *
 * The cookie is read first because it is the one the client cannot tamper with.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cookieName: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    config: ConfigService,
  ) {
    this.cookieName = config.getOrThrow<string>('auth.cookieName');
  }

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Unauthorized');

    const payload = this.tokenService.verify(token);
    if (!payload) throw new UnauthorizedException('Unauthorized');

    const { exp: _exp, ...user } = payload;
    request.user = user;
    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | null {
    const fromCookie = request.cookies?.[this.cookieName] as
      | string
      | undefined;
    if (fromCookie) return fromCookie;

    const header = request.headers.authorization ?? '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
  }
}
