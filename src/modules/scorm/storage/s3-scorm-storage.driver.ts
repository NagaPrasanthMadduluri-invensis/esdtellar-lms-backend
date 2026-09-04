import type { Readable } from 'node:stream';

import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';

import { R2StorageService } from '@/modules/media/storage/r2-storage.service';

import { contentTypeFor } from './content-type.util';
import type {
  PackageLocation,
  ScormAsset,
  ScormStorageDriver,
} from './scorm-storage.driver';

/**
 * How many object PUTs are in flight at once while unpacking.
 *
 * A SCORM package is hundreds of small files, so uploading them one at a time
 * makes extraction latency the sum of hundreds of round trips. Unbounded
 * `Promise.all` over every entry is the other failure: a 2,000-file package
 * would open 2,000 sockets, and the SDK's own connection pool would queue them
 * anyway while the process held every decompressed buffer in memory at once.
 */
const UPLOAD_CONCURRENCY = 16;

/** Entries above this are streamed rather than buffered whole. */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/**
 * Cloudflare R2 driver (BACKEND_STRUCTURE.md §10.3).
 *
 * Solves the single-instance bottleneck: every API process reads the same
 * bucket, so a package unzipped by one instance is immediately servable by all
 * of them, and a deploy no longer strands `server/storage/scorm/`.
 *
 * Reuses `R2StorageService` rather than constructing a second `S3Client`.
 * Credentials, endpoint quirks (path-style addressing, the
 * `requestChecksumCalculation` trap that otherwise breaks presigned PUTs) and
 * the missing-credential 503 behaviour are all solved there, and having two
 * clients would mean two places to fix the next one.
 *
 * KEY LAYOUT — `tenants/<organizationId>/scorm/<packageDir>/<entry path>`.
 *
 * The tenant segment is first so that a bucket policy, a lifecycle rule or an
 * `aws s3 ls` can be scoped to one customer's data without pattern-matching
 * the middle of a key. `packageDir` (a UUID) rather than a course id is the
 * second segment because that is this system's actual addressing unit for a
 * package: `scorm_packages.course_id` is nullable — a package can be uploaded
 * to the library before it is attached to any course, and reused across
 * several — so a course-keyed prefix would be null for most rows and would
 * have to move whenever the attachment changed.
 */
@Injectable()
export class S3ScormStorageDriver implements ScormStorageDriver {
  readonly kind = 's3' as const;

  private readonly logger = new Logger(S3ScormStorageDriver.name);

  constructor(private readonly r2: R2StorageService) {
    if (!this.r2.isConfigured) {
      // Matches R2StorageService's own stance: not a boot failure, because the
      // rest of the API is useful without SCORM, and making object storage a
      // hard dependency of startup would take the whole LMS down over a typo
      // in one variable. SCORM routes raise 503 with the variable NAMES.
      this.logger.warn(
        'SCORM_STORAGE_DRIVER=s3 but R2 is not configured. SCORM upload and ' +
          'content serving will return 503 until the R2_* variables are set ' +
          'and the process is RESTARTED — config is read once at boot.',
      );
    }
  }

  get isReady(): boolean {
    return this.r2.isConfigured;
  }

  get missingConfig(): string[] {
    return this.r2.missingVariables;
  }

  /** `tenants/<org>/scorm/<dir>/` — always with the trailing slash. */
  buildPrefix(organizationId: number, packageDir: string): string {
    return `tenants/${organizationId}/scorm/${packageDir}/`;
  }

  /**
   * Unpacks the zip in this process and streams each entry to R2.
   *
   * The zip is decompressed in memory (adm-zip, as before) but entries are
   * released one at a time as they are uploaded, so peak memory is the archive
   * plus `UPLOAD_CONCURRENCY` entries — not the archive plus its full expansion.
   *
   * On ANY failure every object written so far is deleted before the error
   * propagates. A half-extracted package in object storage is worse than none:
   * the row would be rolled back by the caller and the objects would be
   * unreferenced, paying storage forever with nothing pointing at them.
   */
  async extract(
    packageDir: string,
    buffer: Buffer,
    organizationId: number,
  ): Promise<{ manifestXml: string; storagePrefix: string } | null> {
    // Touches `this.r2.requireConfigured()` first so a missing credential is a
    // clean 503 before the CPU is spent decompressing a 100 MB archive.
    this.r2.requireConfigured();

    const storagePrefix = this.buildPrefix(organizationId, packageDir);
    const zip = new AdmZip(buffer);

    const entries = zip
      .getEntries()
      .filter((entry) => !entry.isDirectory)
      .map((entry) => ({
        // Zip entry names use forward slashes by spec, but real-world archives
        // from Windows authoring tools carry backslashes. Normalizing here
        // keeps `imsmanifest.xml` findable and the served keys consistent.
        name: entry.entryName.replace(/\\/g, '/'),
        entry,
      }))
      // A zip can name an entry `../../etc/passwd` — "zip slip". On disk that
      // is a write outside the root; in a key space it silently produces a key
      // that no request path can ever resolve back to, so the file becomes
      // unreachable garbage. Rejected either way.
      .filter(({ name }) => !name.split('/').includes('..') && !name.startsWith('/'));

    if (entries.length === 0) return null;

    const manifestEntry = entries.find(
      ({ name }) => name.toLowerCase() === 'imsmanifest.xml',
    );
    if (!manifestEntry) return null;

    const written: string[] = [];
    try {
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(UPLOAD_CONCURRENCY, entries.length) },
        async () => {
          while (cursor < entries.length) {
            const { name, entry } = entries[cursor++];
            if (entry.header.size > MAX_ENTRY_BYTES) {
              throw new Error(
                `Package entry ${name} is ${entry.header.size} bytes, over the ` +
                  `${MAX_ENTRY_BYTES}-byte per-file limit.`,
              );
            }
            const key = `${storagePrefix}${name}`;
            await this.r2.putObject(
              key,
              entry.getData(),
              contentTypeFor(name),
            );
            written.push(key);
          }
        },
      );
      await Promise.all(workers);

      return {
        manifestXml: manifestEntry.entry.getData().toString('utf-8'),
        storagePrefix,
      };
    } catch (error) {
      this.logger.error(
        `SCORM extraction to R2 failed for ${packageDir} after ${written.length} ` +
          `object(s); rolling them back. ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      await this.r2.deletePrefix(storagePrefix);
      throw error;
    }
  }

  /** Deletes every object under the package's prefix. Never throws. */
  async remove(location: PackageLocation): Promise<void> {
    if (!location.storagePrefix) {
      // A row written by the `local` driver has nothing here to delete. Its
      // files are on the disk of whichever instance unzipped them, which is
      // the bottleneck this driver exists to remove — say so rather than
      // silently reporting success.
      this.logger.warn(
        `Package ${location.packageDir} has no storage_prefix, so it was ` +
          'stored on local disk and cannot be removed from object storage.',
      );
      return;
    }
    await this.r2.deletePrefix(location.storagePrefix);
  }

  /**
   * Key-space path resolution. Deliberately stricter than the filesystem rule
   * in `LocalScormStorageDriver`, and for a different reason: S3 has no `..`,
   * no symlinks and no case-folding, so there is nothing to "escape" — but a
   * key containing `../` is perfectly storable, which means a request path
   * that still contains one after a single decode must be refused rather than
   * collapsed. Collapsing would let `/<A>/../<B>/x` authorize against `<A>`
   * and then fetch `<B>`'s object, the same two-interpretation trap the local
   * driver closes by normalizing the way `send` does.
   */
  resolvePackageDir(requestPath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(requestPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;

    const segments = decoded.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    // No normalization: any dot-segment anywhere is a hard reject, so the
    // authorized address and the fetched key are the same string by construction.
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      return null;
    }
    return segments[0];
  }

  async openAsset(
    location: PackageLocation,
    relativePath: string,
  ): Promise<ScormAsset | null> {
    if (!location.storagePrefix) return null;
    this.r2.requireConfigured();

    const key = `${location.storagePrefix}${relativePath}`;
    const object = await this.r2.getObjectStream(key);
    if (!object) return null;

    return {
      stream: object.stream as Readable,
      // R2 returns what was stored at upload; `contentTypeFor` is the fallback
      // so a package uploaded before the mapping existed still serves usably.
      contentType: object.contentType ?? contentTypeFor(key),
      contentLength: object.contentLength,
      etag: object.etag,
    };
  }

  /**
   * A presigned GET. NOT used for the player iframe — see the note on
   * `ScormStorageService.assetUrlForPlayer`. Available for an admin
   * downloading a stored file, or for confirming what was actually written.
   */
  async signedAssetUrl(
    location: PackageLocation,
    relativePath: string,
    ttlSeconds?: number,
  ): Promise<string | null> {
    if (!location.storagePrefix) return null;
    this.r2.requireConfigured();
    return this.r2.presignDownload(
      `${location.storagePrefix}${relativePath}`,
      ttlSeconds,
    );
  }
}
