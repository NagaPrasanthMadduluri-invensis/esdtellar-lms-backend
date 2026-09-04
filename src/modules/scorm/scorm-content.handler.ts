import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { ScormRepository } from './scorm.repository';
import { ScormStorageService } from './storage/scorm-storage.service';

/**
 * Streams SCORM package assets out of object storage at `/scorm/<dir>/<file>`.
 *
 * Mounted by hand in `main.ts` INSTEAD OF `useStaticAssets` when
 * `SCORM_STORAGE_DRIVER=s3`, immediately after `ScormContentMiddleware` — so
 * authentication, the entitlement check and the traversal guard have all
 * already run by the time this sees a request. It performs no authorization of
 * its own and must never be mounted without that middleware in front of it.
 *
 * WHY THIS EXISTS AT ALL, rather than redirecting to a presigned R2 URL:
 * SCORM content calls `window.parent.API.LMSSetValue(...)`, and a frame served
 * from `*.r2.cloudflarestorage.com` is cross-origin to the player page, so
 * those calls throw on property access and the package tracks nothing —
 * silently. Keeping the URL same-origin (Next rewrite -> this API -> R2) is
 * what preserves the bridge while moving the bytes off local disk. See
 * BACKEND_STRUCTURE.md §10.1 and the note on `ScormStorageService`.
 */
@Injectable()
export class ScormContentHandler {
  private readonly logger = new Logger(ScormContentHandler.name);

  constructor(
    private readonly storage: ScormStorageService,
    private readonly repository: ScormRepository,
  ) {}

  handler = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // Only GET/HEAD — a package asset is never written through this path, and
    // anything else should 404 rather than fall through to the Nest router.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).set('Allow', 'GET, HEAD').end();
      return;
    }

    const packageDir = this.storage.resolvePackageDir(req.path);
    if (!packageDir) {
      res.status(404).type('html').send(NOT_FOUND_HTML);
      return;
    }

    // The relative path within the package, taken from the SAME decoded value
    // the guard resolved rather than re-derived from the raw URL — two
    // interpretations of one path is the bug class the guard exists to close.
    const relativePath = decodeURIComponent(req.path)
      .split('/')
      .filter(Boolean)
      .slice(1)
      .join('/');
    if (!relativePath) {
      res.status(404).type('html').send(NOT_FOUND_HTML);
      return;
    }

    try {
      // Unscoped BY DESIGN, and narrowly so: this resolves a package's storage
      // location from its UUID directory name, which the middleware in front
      // has already authorized for this caller. It cannot be org-scoped here
      // because a platform-owned package is served to every tenant, and the
      // key prefix belongs to the OWNER (see `PackageLocation`). Entitlement
      // is the middleware's job; this is address resolution.
      const location = await this.repository.findLocationByPackageDir(packageDir);
      if (!location) {
        res.status(404).type('html').send(NOT_FOUND_HTML);
        return;
      }

      const asset = await this.storage.openAsset(location, relativePath);
      if (!asset) {
        res.status(404).type('html').send(NOT_FOUND_HTML);
        return;
      }

      res.setHeader('Content-Type', asset.contentType);
      if (asset.contentLength !== null) {
        res.setHeader('Content-Length', String(asset.contentLength));
      }
      if (asset.etag) res.setHeader('ETag', asset.etag);
      // Package contents are immutable once extracted — a new upload gets a new
      // package_dir — so they are safely cacheable. `private` because the URL
      // is only reachable with the learner's cookie and a shared cache must not
      // hold it for the next caller.
      res.setHeader('Cache-Control', 'private, max-age=3600');
      // These bytes are third-party authored content running in an iframe.
      // nosniff keeps a mistyped asset from being reinterpreted as script.
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method === 'HEAD') {
        asset.stream.destroy();
        res.end();
        return;
      }

      asset.stream.on('error', (error) => {
        this.logger.error(
          `Stream failed for ${packageDir}/${relativePath}: ${error.message}`,
        );
        // Headers are already sent by the time a stream breaks mid-flight, so
        // the only honest signal left is to drop the connection. Writing an
        // error body here would append HTML to a partial asset.
        res.destroy(error);
      });
      asset.stream.pipe(res);
    } catch (error) {
      // Fail closed and QUIETLY, for the same reason the middleware does: this
      // path is mounted before the Nest pipeline, so `HttpExceptionFilter`
      // never sees it and Express's default finalhandler would put `err.stack`
      // in a response body rendered inside the learner's iframe (§8.3).
      this.logger.error(
        `SCORM content failed for ${packageDir}/${relativePath}`,
        error instanceof Error ? error.stack : String(error),
      );
      if (!res.headersSent) {
        res.status(404).type('html').send(NOT_FOUND_HTML);
      } else {
        res.destroy();
      }
      return;
    }
  };
}

/** Matches the middleware's own 404 body, so the two are indistinguishable. */
const NOT_FOUND_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Not found</title>
  </head>
  <body style="font-family: sans-serif; text-align: center; padding-top: 3rem; color: #0A1628;">
    <h1>Not found</h1>
    <p>This content is unavailable.</p>
  </body>
</html>`;
