import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Course thumbnails on local disk.
 *
 * Deliberately NOT R2, unlike lesson video and documents. Those are private
 * per learner and are handed out as short-lived presigned URLs, minted per
 * click. A thumbnail is the opposite: it is rendered by `next/image` on every
 * course card, so its URL has to be stable, cacheable and fetchable by the
 * image optimizer — which runs server-side and carries no cookie. A signed URL
 * with a TTL is the wrong shape for that, and the R2 variables are optional
 * (§9.1), so an R2-only thumbnail would be a dead button in any deployment
 * that has not configured them.
 *
 * The cost is the `local` SCORM driver's cost: a second API process cannot see
 * what this one wrote. Put the uploads directory on shared storage before
 * running more than one instance.
 */
@Injectable()
export class ImageStorageService {
  private readonly logger = new Logger(ImageStorageService.name);

  /** Where the public URL path begins. Matches the `useStaticAssets` prefix. */
  static readonly PUBLIC_PREFIX = '/uploads/course-thumbnails/';

  /** A stored thumbnail, and nothing else: our prefix, a UUID, a known extension. */
  static readonly PUBLIC_PATH_PATTERN =
    /^\/uploads\/course-thumbnails\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

  /** Absolute root that `useStaticAssets` mounts at `/uploads`. */
  readonly rootPath: string;

  private readonly thumbnailDir: string;

  constructor(config: ConfigService) {
    const configured =
      config.get<string>('storage.uploadsPath') ?? './storage/uploads';
    this.rootPath = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
    this.thumbnailDir = join(this.rootPath, 'course-thumbnails');
  }

  /**
   * Writes the bytes and returns the public path to store in
   * `courses.thumbnail_url`.
   *
   * The filename is a fresh UUID on every upload, never derived from the
   * uploaded filename. Two reasons: a caller cannot steer the write outside
   * this directory, and replacing a thumbnail never reuses a path, so the
   * static handler can serve it as immutable and no CDN or browser holds the
   * previous picture.
   */
  async saveThumbnail(bytes: Buffer, extension: string): Promise<string> {
    await mkdir(this.thumbnailDir, { recursive: true });
    const filename = `${randomUUID()}.${extension}`;
    await writeFile(join(this.thumbnailDir, filename), bytes);
    return `${ImageStorageService.PUBLIC_PREFIX}${filename}`;
  }

  /** True for a path this service produced — the only thing `remove` will touch. */
  static isStoredThumbnail(url: string): boolean {
    return ImageStorageService.PUBLIC_PATH_PATTERN.test(url);
  }

  /**
   * Best-effort deletion of a replaced or cleared thumbnail (§8.4).
   *
   * Never throws: an orphaned 200 KB file costs disk, a thrown error costs the
   * admin the edit that was the point of the request. An external URL is not
   * ours and is left alone.
   */
  async removeThumbnail(url: string | null | undefined): Promise<void> {
    if (!url || !ImageStorageService.isStoredThumbnail(url)) return;
    const filename = url.slice(ImageStorageService.PUBLIC_PREFIX.length);
    try {
      await unlink(join(this.thumbnailDir, filename));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      this.logger.warn(`Could not delete thumbnail ${filename}: ${String(error)}`);
    }
  }
}
