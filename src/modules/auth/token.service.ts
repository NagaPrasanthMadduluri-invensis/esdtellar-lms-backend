import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  AuthenticatedUser,
  JwtPayload,
} from '@/common/types/authenticated-request';

/**
 * Hand-rolled HS256 JWT, byte-compatible with the legacy `lib/auth.js`.
 *
 * Why not @nestjs/jwt: during the migration the Next.js route handlers that
 * have not moved yet still verify these tokens with the legacy implementation.
 * The wire format must stay identical until the last of them is ported; only
 * then is swapping the implementation a free change.
 */
@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly tokenDays: number;

  constructor(private readonly config: ConfigService) {
    this.secret = this.config.getOrThrow<string>('auth.jwtSecret');
    this.tokenDays = this.config.getOrThrow<number>('auth.tokenDays');
  }

  /** Lifetime in seconds — the cookie Max-Age must match the token exp. */
  get maxAgeSeconds(): number {
    return this.tokenDays * 86_400;
  }

  sign(user: AuthenticatedUser): string {
    const header = this.encode({ alg: 'HS256', typ: 'JWT' });
    const claims = this.encode({
      ...user,
      exp: Math.floor(Date.now() / 1000) + this.maxAgeSeconds,
    });
    return `${header}.${claims}.${this.signature(`${header}.${claims}`)}`;
  }

  /** Returns the claims, or null for any malformed, forged, or expired token. */
  verify(token: string): JwtPayload | null {
    try {
      const [header, claims, signature] = token.split('.');
      if (!header || !claims || !signature) return null;

      const expected = this.signature(`${header}.${claims}`);
      const provided = Buffer.from(signature);
      const computed = Buffer.from(expected);
      if (provided.length !== computed.length) return null;
      if (!timingSafeEqual(provided, computed)) return null;

      const payload = JSON.parse(
        Buffer.from(claims, 'base64url').toString(),
      ) as JwtPayload;

      if (typeof payload.exp !== 'number') return null;
      if (payload.exp < Math.floor(Date.now() / 1000)) return null;

      // Every token minted since the multi-tenancy migration carries
      // `organizationId` (spec §4.1). A token without it predates that
      // migration and cannot be trusted with any org — there is no default
      // that would not silently leak one tenant's data into another's
      // session. Rejecting it here, rather than downstream, is what makes
      // deploying this change sign every existing session out at once.
      if (typeof payload.organizationId !== 'number') return null;

      return payload;
    } catch {
      return null;
    }
  }

  private signature(input: string): string {
    return createHmac('sha256', this.secret).update(input).digest('base64url');
  }

  private encode(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
  }
}
