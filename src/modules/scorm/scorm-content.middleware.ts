import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

import { TokenService } from '@/modules/auth/token.service';

import { createOrgScope } from '@/database/org-scope';
import { OrganizationsService } from '@/modules/organizations/organizations.service';

import { EntitlementCache } from './entitlement-cache';
import { ScormService } from './scorm.service';
import { ScormStorageService } from './storage/scorm-storage.service';

/**
 * Authenticates every request under `/scorm` before `useStaticAssets` ever
 * touches disk (`multi-tenancy.md` §3.9). Registered by hand in `main.ts` —
 * see the comment there for why `MiddlewareConsumer` cannot be used.
 *
 * Renders plain HTML, not the JSON envelope `HttpExceptionFilter` produces
 * elsewhere: this content loads inside the SCORM player's iframe, and a raw
 * JSON body would render as text in the frame instead of a message a learner
 * can act on.
 *
 * A miss is always 404, never 403 — a 403 would confirm the package exists,
 * which is exactly the information a stranger holding a UUID is trying to
 * extract.
 *
 * SECURITY NOTE — the two-interpretation trap. The server behind this
 * middleware (`express.static` on the `local` driver, `ScormContentHandler` on
 * `s3`) resolves the SAME request by decoding the URL path and then
 * `path.normalize`-ing it: `..` segments collapse against whatever precedes
 * them, so `/<A>/../<B>/x` and `/<A>/x` are different addresses of the same
 * file once decoded and normalized, even though `..` never escapes the
 * static root. A guard that only inspects the RAW first path segment sees
 * `<A>` (entitled) and waves the request through, while the file actually
 * served — after that same decode+normalize — is `<B>`'s. This class
 * authorizes on the address the driver will actually resolve, obtained from
 * the driver itself, never on the raw segment alone. The resolution rule lives
 * in the driver because a filesystem and a key space differ: disk collapses
 * `..`, object storage has nothing to collapse and rejects it outright.
 */
@Injectable()
export class ScormContentMiddleware {
  private readonly logger = new Logger(ScormContentMiddleware.name);
  private readonly cookieName: string;

  constructor(
    private readonly tokenService: TokenService,
    private readonly scormService: ScormService,
    private readonly organizations: OrganizationsService,
    private readonly entitlementCache: EntitlementCache,
    private readonly storage: ScormStorageService,
    config: ConfigService,
  ) {
    this.cookieName = config.getOrThrow<string>('auth.cookieName');
  }

  /**
   * Bound instance property (not a prototype method) so `main.ts` can pass
   * `app.get(ScormContentMiddleware).handler` straight to `app.use` without
   * losing `this`.
   */
  handler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // 1. Verify the token — HMAC only, zero database work.
    const token = req.cookies?.[this.cookieName] as string | undefined;
    const payload = token ? this.tokenService.verify(token) : null;
    if (!payload) {
      this.sendHtml(
        res,
        401,
        'Session expired',
        'Your session expired — reload to continue.',
      );
      return;
    }

    // 2. Cheap early-out: reject an outright malicious-looking raw first
    // segment before doing any real work. This alone is NOT the traversal
    // guard — step 3 is — but it costs nothing and catches the common case
    // (`/scorm/../../etc/passwd`) without decoding or touching the cache.
    const rawSegment = this.firstRawSegment(req.path);
    if (!rawSegment) {
      this.sendHtml(res, 404, 'Not found', 'This content is unavailable.');
      return;
    }

    // 3. Resolve the path the same way whatever serves it will resolve it,
    // and take THAT result's first segment as the package directory to
    // authorize — not the raw segment from step 2.
    //
    // Delegated to the storage driver rather than resolved here. The two
    // backing stores have genuinely different path semantics — a filesystem
    // collapses `..`, a key space does not — and the guard has to resolve the
    // address that will ACTUALLY be served, which now depends on which driver
    // serves it. Keeping this logic in one place while `useStaticAssets` and
    // `ScormContentHandler` resolved paths differently would reintroduce the
    // two-interpretation trap this whole check exists to close.
    const resolvedSegment = this.storage.resolvePackageDir(req.path);
    if (!resolvedSegment || resolvedSegment !== rawSegment) {
      // Exact segment comparison, not `startsWith` — "abc" must never match
      // "abcd" — and any mismatch between the two interpretations means the
      // raw segment we would have authorized is not the one actually served.
      this.sendHtml(res, 404, 'Not found', 'This content is unavailable.');
      return;
    }
    const packageDir = resolvedSegment;

    // 4. Cache lookup; one query on a miss (§7.1 — 50-200 assets per launch).
    const isAdmin = payload.role === 'admin';
    let entitled = this.entitlementCache.get(payload.userId, packageDir);
    if (entitled === null) {
      try {
        // This middleware runs BEFORE the Nest guard chain, so there is no
        // TenantContextGuard to have minted a scope and no @CurrentScope() to
        // read. The organizationId comes from the same verified JWT the guard
        // would have used — never from the URL, a header, or anything the
        // caller controls.
        entitled = await this.scormService.isEntitledToPackageDir(
          createOrgScope(
            payload.organizationId,
            this.organizations.getPlatformOrganizationId(),
          ),
          payload.userId,
          packageDir,
          isAdmin,
        );
      } catch (error) {
        // Fail closed, and fail QUIETLY. Letting this reject would hand the
        // request to Express's default finalhandler, which embeds err.stack in
        // the response body whenever NODE_ENV !== 'production' — a stack trace
        // rendered inside the learner's player iframe. This route is mounted
        // before the Nest pipeline, so HttpExceptionFilter (which exists to
        // stop exactly that, BACKEND_STRUCTURE.md §8.3) never sees it.
        this.logger.error(
          `Entitlement check failed for package ${packageDir}`,
          error instanceof Error ? error.stack : String(error),
        );
        this.sendHtml(res, 404, 'Not found', 'This content is unavailable.');
        return;
      }
      this.entitlementCache.set(payload.userId, packageDir, entitled);
    }

    if (!entitled) {
      this.sendHtml(res, 404, 'Not found', 'This content is unavailable.');
      return;
    }

    next();
  };

  /**
   * The raw (still percent-encoded) first path segment, rejected outright if
   * it contains a literal `..` or a path separator. Cheap and necessary, but
   * insufficient alone — step 3 is the real guard.
   */
  private firstRawSegment(rawPath: string): string | null {
    const segment = rawPath.split('/').filter(Boolean)[0];
    if (!segment) return null;
    if (
      segment.includes('..') ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      return null;
    }
    return segment;
  }

  private sendHtml(
    res: Response,
    status: number,
    title: string,
    message: string,
  ): void {
    res
      .status(status)
      .type('html')
      .send(
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body style="font-family: sans-serif; text-align: center; padding-top: 3rem; color: #0A1628;">
    <h1>${title}</h1>
    <p>${message}</p>
  </body>
</html>`,
      );
  }
}
