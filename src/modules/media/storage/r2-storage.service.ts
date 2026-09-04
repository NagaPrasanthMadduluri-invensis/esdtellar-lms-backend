import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Result of a HeadObject probe. */
export interface ObjectStat {
  size: number;
  contentType: string | null;
}

/** An object opened for streaming straight into an HTTP response. */
export interface ObjectStream {
  stream: Readable;
  contentType: string | null;
  contentLength: number | null;
  etag: string | null;
}

/**
 * Owns every call to Cloudflare R2.
 *
 * R2 speaks the S3 API, so this is the AWS SDK pointed at an R2 endpoint. As
 * with `ScormStorageService`, every call site goes through this service rather
 * than constructing its own client, so credentials live in exactly one place
 * and a future provider swap is one file.
 *
 * Large objects (the MP4s) are never proxied through this process. The admin's
 * browser uploads straight to R2 with a presigned PUT and the API only learns
 * the resulting key — so a 2 GB video costs this server no memory and no
 * bandwidth. Only caption files, which are kilobytes, are written through
 * `putObject`.
 */
@Injectable()
export class R2StorageService {
  private readonly logger = new Logger(R2StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;
  /** Names (never values) of the vars that were absent at boot. */
  private readonly missing: string[] = [];

  constructor(private readonly config: ConfigService) {
    const accessKeyId = this.config.get<string>('media.r2.accessKeyId') ?? '';
    const secretAccessKey =
      this.config.get<string>('media.r2.secretAccessKey') ?? '';
    const endpoint = this.config.get<string>('media.r2.endpoint') ?? '';
    this.bucket = this.config.get<string>('media.r2.bucket') ?? '';

    if (!accessKeyId) this.missing.push('R2_ACCESS_KEY_ID');
    if (!secretAccessKey) this.missing.push('R2_SECRET_ACCESS_KEY');
    if (!this.bucket) this.missing.push('R2_BUCKET');
    if (!endpoint) this.missing.push('R2_ENDPOINT (or R2_ACCOUNT_ID)');

    if (this.missing.length > 0) {
      // Deliberately not a boot failure: the rest of the API is useful without
      // video, and failing startup would make R2 a hard dependency of every
      // endpoint. Calls that actually need storage raise 503 instead.
      //
      // The names are repeated in the 503 body as well. Config is read once at
      // boot, so whoever fixes the environment must restart the process — and
      // without that hint a correctly-edited .env looks like it changed nothing.
      this.logger.warn(
        `R2 is not configured — missing: ${this.missing.join(', ')}. ` +
          'Video upload and playback will return 503 until these are set in ' +
          'the environment and the process is RESTARTED.',
      );
      this.client = null;
      return;
    }

    this.client = new S3Client({
      // R2 is not region-partitioned, but SigV4 requires a region to sign with.
      region: 'auto',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // Path-style addressing (<endpoint>/<bucket>/<key>) avoids relying on the
      // bucket resolving as a DNS subdomain, and matches the S3_API_ENDPOINT
      // shape Cloudflare shows in the dashboard.
      forcePathStyle: true,
      /**
       * Without this the SDK defaults to WHEN_SUPPORTED and bakes a CRC32 of
       * the request body into every presigned PUT. When presigning there IS no
       * body, so the value it signs is the checksum of zero bytes
       * (`x-amz-checksum-crc32=AAAAAA==`). The browser then uploads the real
       * file, R2 compares it against that empty-body checksum, and rejects the
       * upload with BadDigest. WHEN_REQUIRED keeps the checksum out of the URL.
       */
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }

  /** True when credentials are present, so callers can fail cleanly. */
  get isConfigured(): boolean {
    return this.client !== null;
  }

  private get s3(): S3Client {
    if (!this.client) {
      // Naming the variables is safe here: these routes are admin-only, and
      // only the NAMES are reported, never any value.
      throw new ServiceUnavailableException(
        `File storage is not configured on this server. Missing environment ` +
          `variable(s): ${this.missing.join(', ')}. Video, document and ` +
          `resource uploads need them. Set them on the API server ` +
          `and restart it — configuration is read once at startup.`,
      );
    }
    return this.client;
  }

  /** `lessons/12/video/<uuid>.mp4` — grouped by lesson so cleanup is obvious. */
  buildKey(
    lessonId: number,
    kind: 'video' | 'captions' | 'document' | 'resource',
    extension: string,
  ) {
    return `lessons/${lessonId}/${kind}/${randomUUID()}.${extension}`;
  }

  /**
   * A short-lived URL the browser can PUT the video to directly.
   *
   * `contentType` is signed, so the upload must present exactly the declared
   * type — a URL minted for `video/mp4` cannot be reused to store something
   * else. Byte length is checked against the configured cap before signing and
   * verified for real by `statObject` after the upload completes; a presigned
   * PUT cannot itself enforce a size limit.
   */
  async presignUpload(key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      {
        expiresIn: this.config.get<number>('media.uploadUrlTtlSeconds') ?? 3600,
        // Forces content-type into SignedHeaders. Without it the SDK leaves the
        // header out of the signature and the URL would accept a body of any
        // type; with it, the PUT must present exactly the declared type.
        signableHeaders: new Set(['content-type']),
      },
    );
  }

  /** A short-lived playback URL. TTL comes from VIDEO_URL_TTL_SECONDS. */
  async presignDownload(key: string, ttlSeconds?: number): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn:
          ttlSeconds ?? this.config.get<number>('media.videoUrlTtlSeconds') ?? 900,
      },
    );
  }

  /** Direct write — only for small objects (captions). */
  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Size + type of a stored object, or null when it does not exist. */
  async statObject(key: string): Promise<ObjectStat | null> {
    try {
      const head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: Number(head.ContentLength ?? 0),
        contentType: head.ContentType ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Best-effort delete. Removing the old object when a video is replaced must
   * never fail the replacement itself (BACKEND_STRUCTURE.md §8.4) — an orphaned
   * object costs storage, a thrown error costs the admin their edit.
   */
  async deleteObject(key: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.s3.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      this.logger.warn(
        `Could not delete R2 object ${key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  /**
   * Names (never values) of the absent variables. Exposed so another module's
   * driver can report the same list in its own 503 without duplicating the
   * check — `S3ScormStorageDriver` does exactly that.
   */
  get missingVariables(): string[] {
    return [...this.missing];
  }

  /**
   * Throws the 503 if credentials are absent, without performing a request.
   *
   * Callers that are about to do expensive local work first — decompressing a
   * 100 MB SCORM archive, for instance — use this so a misconfigured server
   * fails immediately instead of after the CPU has been spent.
   */
  requireConfigured(): void {
    void this.s3;
  }

  /**
   * Opens an object for streaming, or null when it does not exist.
   *
   * Distinguishes "absent" from "unreachable" deliberately: a genuine 404/
   * NoSuchKey returns null so the caller can render its own not-found, while a
   * credential, network or timeout failure propagates — masking that as an
   * empty result would make a broken bucket look exactly like a package whose
   * files were never uploaded (BACKEND_STRUCTURE.md §8.3).
   */
  async getObjectStream(key: string): Promise<ObjectStream | null> {
    try {
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return {
        stream: result.Body as Readable,
        contentType: result.ContentType ?? null,
        contentLength:
          result.ContentLength === undefined ? null : Number(result.ContentLength),
        etag: result.ETag ?? null,
      };
    } catch (error) {
      if (this.isNotFound(error)) return null;
      throw error;
    }
  }

  /** Every key under a prefix, paginated. */
  async listPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of page.Contents ?? []) {
        if (item.Key) keys.push(item.Key);
      }
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);

    return keys;
  }

  /**
   * Best-effort delete of everything under a prefix, in batches of 1000 —
   * the DeleteObjects hard limit.
   *
   * A SCORM package is hundreds of objects, so deleting them one at a time
   * would be hundreds of round trips for a single admin action (§7.1 applies
   * to object storage for the same reason it applies to Postgres). Like
   * `deleteObject`, a failure is logged rather than thrown: an orphaned object
   * costs storage, a thrown error costs the admin their deletion (§8.4).
   */
  async deletePrefix(prefix: string): Promise<void> {
    if (!this.client) return;
    try {
      const keys = await this.listPrefix(prefix);
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not delete R2 prefix ${prefix}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * A genuinely-absent object, as opposed to any other failure. The SDK
   * reports this as NoSuchKey / NotFound, or a bare 404 status.
   */
  private isNotFound(error: unknown): boolean {
    const candidate = error as {
      name?: string;
      Code?: string;
      $metadata?: { httpStatusCode?: number };
    };
    return (
      candidate?.name === 'NoSuchKey' ||
      candidate?.name === 'NotFound' ||
      candidate?.Code === 'NoSuchKey' ||
      candidate?.$metadata?.httpStatusCode === 404
    );
  }
}
