import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { LocalScormStorageDriver } from './local-scorm-storage.driver';
import {
  SCORM_STORAGE_DRIVER,
  type PackageLocation,
  type ScormAsset,
  type ScormStorageDriver,
} from './scorm-storage.driver';

/**
 * Owns SCORM package files, delegating to whichever driver
 * `SCORM_STORAGE_DRIVER` selected.
 *
 * This class is the seam BACKEND_STRUCTURE.md §10.3 asked for: call sites talk
 * to it and never to a driver, so `local` -> `s3` is an environment variable
 * rather than a code change anywhere in `ScormService`.
 *
 * WHY THE PLAYER IFRAME STILL POINTS AT THIS API, EVEN ON s3
 * ----------------------------------------------------------
 * The obvious cloud-native move — hand the browser a presigned R2 URL and let
 * it load the package directly — CANNOT be used for the player, and the reason
 * is not performance but the same-origin policy (§10.1).
 *
 * SCORM content talks to the LMS by calling `window.parent.API.LMSSetValue(...)`
 * from inside the iframe. A frame loaded from `*.r2.cloudflarestorage.com`
 * is cross-origin to the player page, so every one of those calls throws on
 * property access and the package silently records nothing — it does not error
 * visibly, it just never tracks. That is why `client/next.config.mjs` rewrites
 * `/scorm/:path*` to this API in the first place.
 *
 * So the bytes move to object storage while the URL stays same-origin: the
 * browser requests `/scorm/<dir>/<file>` from the Next origin, Next rewrites to
 * this API, and this API streams the object out of R2. The single-instance
 * bottleneck is gone — any instance can serve any package — without breaking
 * the parent-window bridge. `signedAssetUrl` exists for out-of-band use
 * (an admin download, or confirming what was stored), not for the frame.
 */
@Injectable()
export class ScormStorageService {
  private readonly logger = new Logger(ScormStorageService.name);

  constructor(
    @Inject(SCORM_STORAGE_DRIVER)
    private readonly driver: ScormStorageDriver,
    config: ConfigService,
  ) {
    const configured = config.get<string>('storage.driver') ?? 'local';
    this.logger.log(
      `SCORM storage driver: ${this.driver.kind}` +
        (this.driver.isReady
          ? ''
          : ` (NOT READY — missing ${this.driver.missingConfig.join(', ')})`),
    );
    if (configured !== this.driver.kind) {
      // Only reachable if the factory and the config disagree, which would
      // mean packages were being written somewhere other than where the
      // operator asked. Loud, because it is silent data misplacement.
      this.logger.error(
        `SCORM_STORAGE_DRIVER is "${configured}" but the resolved driver is ` +
          `"${this.driver.kind}".`,
      );
    }
  }

  get driverKind(): 'local' | 's3' {
    return this.driver.kind;
  }

  get isReady(): boolean {
    return this.driver.isReady;
  }

  get missingConfig(): string[] {
    return this.driver.missingConfig;
  }

  /**
   * The local storage root. Only meaningful for the `local` driver, where
   * `main.ts` hands it to `useStaticAssets`. Throws on `s3` rather than
   * returning a misleading path — a caller reaching for a filesystem root
   * under object storage has a bug, and an empty string would let it mount
   * `express.static` on the process's working directory.
   */
  get rootPath(): string {
    if (this.driver instanceof LocalScormStorageDriver) {
      return this.driver.rootPath;
    }
    throw new Error(
      `SCORM storage driver "${this.driver.kind}" has no local root path. ` +
        'Serve content through ScormContentController instead.',
    );
  }

  /**
   * Unpacks an uploaded package. Returns the manifest XML plus the storage
   * prefix to record on the row, or null when the archive has no
   * `imsmanifest.xml`.
   */
  async extract(
    packageDir: string,
    buffer: Buffer,
    organizationId: number,
  ): Promise<{ manifestXml: string; storagePrefix: string | null } | null> {
    return this.driver.extract(packageDir, buffer, organizationId);
  }

  /** Best-effort teardown. Never throws (§8.4). */
  async remove(location: PackageLocation): Promise<void> {
    return this.driver.remove(location);
  }

  /**
   * The package directory a `/scorm/...` request resolves to, or null.
   *
   * Delegated to the driver because the two storage models have genuinely
   * different path semantics — a filesystem collapses `..`, a key space does
   * not — and the guard has to match the address that will actually be served.
   */
  resolvePackageDir(requestPath: string): string | null {
    return this.driver.resolvePackageDir(requestPath);
  }

  async openAsset(
    location: PackageLocation,
    relativePath: string,
  ): Promise<ScormAsset | null> {
    return this.driver.openAsset(location, relativePath);
  }

  /** Out-of-band only — never for the player iframe. See the class note. */
  async signedAssetUrl(
    location: PackageLocation,
    relativePath: string,
    ttlSeconds?: number,
  ): Promise<string | null> {
    return this.driver.signedAssetUrl(location, relativePath, ttlSeconds);
  }
}
