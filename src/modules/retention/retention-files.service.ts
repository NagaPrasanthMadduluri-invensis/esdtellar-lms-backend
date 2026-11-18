import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { ReleasedFiles } from './retention.repository';

/** A stored UUID filename, the only shape the three stores ever write. */
const STORED_NAME = /^[0-9a-f-]{36}\.[a-z0-9]{3,4}$/;
const AVATAR_PREFIX = '/uploads/avatars/';

/**
 * Deletes the files a retention scrub released, from the three local stores
 * under UPLOAD_STORAGE_PATH: avatars/ (ImageStorageService), shared/ (community
 * and message attachments, SharedFileService) and external-certifications/
 * (CertificateFileService).
 *
 * Its own small service rather than importing MediaModule and the others,
 * because the sweep runs in the WORKER, which should not construct the R2
 * client and half the API to remove three kinds of file. Every name is
 * re-checked against the UUID shape those stores write, so a value from the
 * database can never point outside its directory.
 *
 * Best-effort (§8.4): a file already gone is fine, and a failure is logged,
 * never thrown, because the database rows have already been committed.
 */
@Injectable()
export class RetentionFilesService {
  private readonly logger = new Logger('Retention');
  private readonly root: string;

  constructor(config: ConfigService) {
    const configured = config.get<string>('storage.uploadsPath') ?? './storage/uploads';
    this.root = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }

  async remove(files: Partial<ReleasedFiles>): Promise<number> {
    const targets: string[] = [];
    for (const url of files.avatars ?? []) {
      const name = url.startsWith(AVATAR_PREFIX) ? url.slice(AVATAR_PREFIX.length) : '';
      if (STORED_NAME.test(name)) targets.push(join(this.root, 'avatars', name));
    }
    for (const name of files.shared ?? []) {
      if (STORED_NAME.test(name)) targets.push(join(this.root, 'shared', name));
    }
    for (const name of files.certificates ?? []) {
      if (STORED_NAME.test(name)) targets.push(join(this.root, 'external-certifications', name));
    }
    let removed = 0;
    for (const path of targets) {
      try {
        await unlink(path);
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(`Could not delete ${path}: ${String(error)}`);
        }
      }
    }
    return removed;
  }
}
