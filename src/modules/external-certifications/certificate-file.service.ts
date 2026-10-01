import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CERTIFICATE_EXTENSION } from '@/common/external-certifications';

/**
 * The uploaded certificate on local disk.
 *
 * LOCAL DISK, NOT R2, and the reason is the opposite of the one §10.10 gives
 * for thumbnails. A thumbnail is public and needs a stable anonymous URL; a
 * certificate is somebody's personal document and must never have one. What
 * makes disk the right choice here instead is that the R2 variables are
 * OPTIONAL (§9.1) — an R2-only certificate would be a dead Submit button in
 * any deployment that has not configured them, including a developer's.
 *
 * So the bytes sit under `UPLOAD_STORAGE_PATH/external-certifications/`,
 * which `useStaticAssets` does NOT serve: that handler is mounted at
 * `/uploads` and this directory is deliberately outside it. The only way to
 * read one is the authenticated route, which checks who is asking.
 *
 * The cost is the `local` SCORM driver's cost, stated again: a second API
 * process cannot see what this one wrote. Put `UPLOAD_STORAGE_PATH` on
 * shared storage before running more than one instance.
 */
@Injectable()
export class CertificateFileService {
  private readonly logger = new Logger(CertificateFileService.name);
  private readonly dir: string;

  constructor(config: ConfigService) {
    const configured =
      config.get<string>('storage.uploadsPath') ?? './storage/uploads';
    const root = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
    this.dir = join(root, 'external-certifications');
  }

  /**
   * Write the bytes and return the path to store, relative to the directory.
   *
   * The filename is a FRESH UUID every time, never derived from what was
   * uploaded — a caller cannot steer the write out of the directory, and two
   * people uploading `certificate.pdf` cannot collide. The original name is
   * kept on the row instead, for the download's `Content-Disposition`.
   */
  async save(bytes: Buffer, mime: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const name = `${randomUUID()}.${CERTIFICATE_EXTENSION[mime] ?? 'bin'}`;
    await writeFile(join(this.dir, name), bytes);
    return name;
  }

  /**
   * A read stream for a stored file.
   *
   * `storedPath` comes from the database, never from a request, and it is
   * still checked against the UUID shape before being joined — a path that
   * somehow carried `..` would otherwise read anything this process can.
   */
  open(storedPath: string): ReadStream {
    if (!/^[0-9a-f-]{36}\.[a-z]{3,4}$/.test(storedPath)) {
      throw new NotFoundException('Certificate file not found');
    }
    return createReadStream(join(this.dir, storedPath));
  }

  /** Best-effort removal (§8.4) — a file left behind must never fail a
   *  request that has already succeeded. */
  async discard(storedPath: string | null | undefined): Promise<void> {
    if (!storedPath) return;
    try {
      await unlink(join(this.dir, storedPath));
    } catch (error) {
      this.logger.warn(
        `Certificate file not removed (${storedPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
