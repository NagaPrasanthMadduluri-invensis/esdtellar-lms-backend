import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AdmZip from 'adm-zip';
import { contentTypeFor } from './content-type.util';

import type {
  PackageLocation,
  ScormAsset,
  ScormStorageDriver,
} from './scorm-storage.driver';

/**
 * Same regex `send` (the package under `express.static`) uses to detect a `..`
 * segment that survived normalization. Duplicated rather than imported: it is
 * an unexported internal of `send`, and four lines is safer than reaching into
 * another package's private module. Kept here — beside the only driver whose
 * addresses are filesystem paths — rather than in the middleware, which now
 * serves two storage models with different path semantics.
 */
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * The historical driver: packages extracted to disk under
 * `SCORM_STORAGE_PATH/<package_dir>/` and served by `useStaticAssets`.
 *
 * This is the single-instance bottleneck. Two API processes behind a load
 * balancer each only hold the packages they personally unzipped, so a learner's
 * launch fails whenever the balancer routes them to the other one. It remains
 * the default because every existing row was written this way.
 */
@Injectable()
export class LocalScormStorageDriver implements ScormStorageDriver {
  readonly kind = 'local' as const;
  /** Disk is always available; a missing directory is created on demand. */
  readonly isReady = true;
  readonly missingConfig: string[] = [];

  private readonly logger = new Logger(LocalScormStorageDriver.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    const configured = config.getOrThrow<string>('storage.localPath');
    this.root = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
  }

  /** Absolute storage root — `useStaticAssets` mounts this directly. */
  get rootPath(): string {
    return this.root;
  }

  directoryFor(packageDir: string): string {
    return join(this.root, packageDir);
  }

  /**
   * `organizationId` is accepted to satisfy the interface but deliberately
   * unused: the on-disk layout predates multi-tenancy and every existing row
   * points at `<root>/<package_dir>`. Introducing a tenant segment here would
   * orphan every package already stored. Tenant isolation on this driver is
   * enforced by the entitlement check in `ScormContentMiddleware`, not by the
   * path — which is exactly one of the reasons to move to `s3`.
   */
  async extract(
    packageDir: string,
    buffer: Buffer,
    _organizationId: number,
  ): Promise<{ manifestXml: string; storagePrefix: null } | null> {
    const target = this.directoryFor(packageDir);
    await mkdir(target, { recursive: true });

    const zip = new AdmZip(buffer);
    zip.extractAllTo(target, true);

    const manifestPath = join(target, 'imsmanifest.xml');
    if (!existsSync(manifestPath)) {
      await this.remove({ packageDir, storagePrefix: null });
      return null;
    }
    return {
      manifestXml: readFileSync(manifestPath, 'utf-8'),
      storagePrefix: null,
    };
  }

  async remove(location: PackageLocation): Promise<void> {
    try {
      await rm(this.directoryFor(location.packageDir), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      this.logger.warn(
        `Could not remove SCORM directory ${location.packageDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Mirrors `send`'s own pipeline exactly, in the same order, because
   * `express.static` is what actually resolves and serves this request:
   *   1. `decodeURIComponent` ONCE — never twice, which is what makes
   *      double-encoding (`%252f`) inert: it decodes to the two literal
   *      characters `%2f`, not to a separator.
   *   2. Reject a null byte.
   *   3. `normalize('.' + sep + decoded)`, collapsing any `..`.
   *   4. Reject if a `..` segment survived (`send`'s own UP_PATH_REGEXP).
   *   5. Join against the real root, normalize again, and confirm the result
   *      still lives under it — defence in depth beyond step 4.
   *
   * The two-interpretation trap this closes: `/<A>/../<B>/x` and `/<B>/x` are
   * the same file once decoded and normalized, so a guard that authorizes the
   * RAW first segment (`<A>`) would wave through a request that serves `<B>`'s
   * bytes. Authorization must use the address that will actually be served.
   */
  resolvePackageDir(requestPath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(requestPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;

    const normalized = normalize(`.${sep}${decoded}`);
    if (UP_PATH_REGEXP.test(normalized)) return null;

    const joined = normalize(join(this.root, normalized));
    const rootWithSep = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;
    if (joined !== this.root && !joined.startsWith(rootWithSep)) return null;

    const [firstSegment] = joined.slice(rootWithSep.length).split(sep);
    return firstSegment || null;
  }

  async openAsset(
    location: PackageLocation,
    relativePath: string,
  ): Promise<ScormAsset | null> {
    const absolute = join(this.directoryFor(location.packageDir), relativePath);
    // Re-verified rather than trusted: openAsset is public, and a caller that
    // skipped resolvePackageDir must not be able to read outside the root.
    const dirWithSep = `${this.directoryFor(location.packageDir)}${sep}`;
    if (!normalize(absolute).startsWith(dirWithSep)) return null;
    if (!existsSync(absolute)) return null;

    const stat = statSync(absolute);
    if (!stat.isFile()) return null;

    return {
      stream: createReadStream(absolute),
      contentType: contentTypeFor(absolute),
      contentLength: stat.size,
      etag: null,
    };
  }

  /** Disk has no URL of its own; the API streams these bytes itself. */
  async signedAssetUrl(): Promise<null> {
    return null;
  }
}
