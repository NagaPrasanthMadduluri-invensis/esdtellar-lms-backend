import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { AuthRepository } from '@/modules/auth/auth.repository';
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
    private readonly authRepository: AuthRepository,
    config: ConfigService,
  ) {
    this.cookieName = config.getOrThrow<string>('auth.cookieName');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
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

    /**
     * The permission-version check — `specs/rbac.md` §3.6.
     *
     * `permissions[]` rides in the token, so a permission check costs no
     * query. The price is that a 7-day token would otherwise keep honouring a
     * permission that was revoked on day one. Comparing the organization's
     * `perm_version` closes that: any write to `roles` or `role_permissions`
     * bumps it in the same transaction, every token signed before the bump
     * stops verifying, and the client's existing 401 handling sends those
     * users to /login. The effect is scoped to the organization whose roles
     * changed — nobody else is signed out.
     *
     * Deliberately NOT cached with a TTL. `scorm/entitlement-cache.ts` says in
     * its own docblock that its stale-positive pattern must not be reused
     * where a capability is granted, and this is exactly that. The cost is one
     * primary-key lookup per authenticated request; if it ever shows up in a
     * profile, the fix is LISTEN/NOTIFY invalidation, not a time window.
     *
     * A token minted before this claim existed has `permVersion === undefined`
     * and is rejected, which signs every existing session out once on deploy —
     * the same deliberate cost the `organizationId` claim carried.
     */
    const versions = await this.authRepository.findTokenVersions(
      user.userId,
      user.organizationId,
    );
    // Null means the account is gone or deactivated — so deactivating someone
    // now ends their session on their next request, not when the token expires.
    if (versions === null) throw new UnauthorizedException('Unauthorized');
    if (
      user.permVersion !== versions.orgVersion ||
      user.userPermVersion !== versions.userVersion
    ) {
      throw new UnauthorizedException(
        'Permissions changed — please sign in again',
      );
    }

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
