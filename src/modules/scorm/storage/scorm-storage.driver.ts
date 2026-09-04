import type { Readable } from 'node:stream';

/**
 * One stored SCORM asset, ready to be written to an HTTP response.
 *
 * `stream` rather than a Buffer: a package's assets include video and audio
 * that the learner's browser will range-request, and buffering each one into
 * this process would put the whole package's weight in memory per concurrent
 * launch.
 */
export interface ScormAsset {
  stream: Readable;
  contentType: string;
  contentLength: number | null;
  /** Present for object storage; lets the response carry a validator. */
  etag: string | null;
}

/**
 * Where a package's files live, as recorded on `scorm_packages.storage_prefix`.
 *
 * The prefix is STORED rather than recomputed from the row's organization_id
 * because the owner and the reader are not always the same tenant: a package
 * owned by the platform organization is readable by every org (`contentScope`,
 * multi-tenancy.md §3.4). Deriving the prefix from the *requesting* org would
 * look up the wrong keys for exactly those global packages, and deriving it
 * from the owner means every read needs the owner row anyway — so it is
 * written once at upload and read back verbatim.
 *
 * It also makes the local -> s3 move per-package rather than all-or-nothing:
 * a row whose prefix is null predates the scheme and lives on local disk under
 * `<root>/<package_dir>`, which is precisely how existing rows keep working.
 */
export interface PackageLocation {
  packageDir: string;
  /** Null for a package written before object storage — local disk layout. */
  storagePrefix: string | null;
}

/**
 * The storage contract behind `SCORM_STORAGE_DRIVER` (BACKEND_STRUCTURE.md
 * §10.3). Two implementations: `local` (disk, the historical behaviour) and
 * `s3` (Cloudflare R2 through its S3 API).
 *
 * Path resolution is part of this interface ON PURPOSE. The traversal guard in
 * `ScormContentMiddleware` used to reimplement `send`'s disk normalization by
 * hand, which is correct for a filesystem and meaningless for a key space —
 * S3 has no `..`, no symlinks and no case-folding, but it will happily store a
 * key that literally contains `../`. Each driver therefore owns the rule for
 * turning a request path into the address it will actually serve, so the
 * security argument lives next to the storage model instead of assuming disk.
 */
export interface ScormStorageDriver {
  readonly kind: 'local' | 's3';

  /**
   * True when the driver can actually reach its backing store. The `s3` driver
   * reports false with no credentials so callers raise 503 rather than failing
   * mid-upload (BACKEND_STRUCTURE.md §8.3).
   */
  readonly isReady: boolean;

  /** Names of the absent environment variables, for the 503 body. */
  readonly missingConfig: string[];

  /**
   * Unpacks a package zip into storage and returns its `imsmanifest.xml`, or
   * null when the archive has none. `organizationId` is the OWNER's org — it
   * becomes the tenant segment of the key prefix.
   */
  extract(
    packageDir: string,
    buffer: Buffer,
    organizationId: number,
  ): Promise<{ manifestXml: string; storagePrefix: string | null } | null>;

  /** Best-effort teardown of everything under a package. Never throws. */
  remove(location: PackageLocation): Promise<void>;

  /**
   * Resolves a `/scorm/<...>` request path to the package directory whose
   * entitlement must be checked, or null for anything malformed or escaping.
   * Returns the same address the driver will subsequently serve.
   */
  resolvePackageDir(requestPath: string): string | null;

  /**
   * Opens one asset for streaming, or null when it does not exist.
   * `relativePath` is root-relative and already validated by
   * `resolvePackageDir`.
   */
  openAsset(
    location: PackageLocation,
    relativePath: string,
  ): Promise<ScormAsset | null>;

  /**
   * A directly-fetchable URL for one asset, when the driver can mint one.
   *
   * Null for `local`, and NOT used for the player iframe even on `s3` — see
   * the note in `ScormStorageService`. It exists for out-of-band use: an admin
   * downloading a package's file, or debugging what was actually stored.
   */
  signedAssetUrl(
    location: PackageLocation,
    relativePath: string,
    ttlSeconds?: number,
  ): Promise<string | null>;
}

/** DI token — the drivers are classes, the injection point is this symbol. */
export const SCORM_STORAGE_DRIVER = Symbol('SCORM_STORAGE_DRIVER');
