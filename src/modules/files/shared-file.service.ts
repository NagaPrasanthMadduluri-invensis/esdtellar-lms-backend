import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ALLOWED_SHARED_FILE_TYPES,
  SHARED_FILE_EXTENSION,
  SHARED_FILE_MAX_BYTES,
  sniffSharedFileType,
} from '@/common/shared-files';

export interface StoredFile {
  path: string;
  name: string;
  mime: string;
  size: number;
}

/**
 * Disk store for files people share — community Resources and DM attachments.
 *
 * LOCAL DISK, NOT R2, the same reasoning as external certificates (§10.26): the
 * bytes are private (served only through an authenticated route that checks who
 * is asking), and R2 is optional config (§9.1), so an R2-only path would be a
 * dead Share button in any deployment without it. They sit under
 * `UPLOAD_STORAGE_PATH/shared/`, OUTSIDE the directory `useStaticAssets`
 * publishes — there is no URL that serves them without passing a check.
 *
 * ONE store, two callers (community, messages): the metadata row lives on each
 * module's own table, the entitlement is each module's own, but the bytes and
 * the validation are shared so the two surfaces cannot drift.
 *
 * Single-instance caveat, stated again: a second API process cannot see what
 * this one wrote. Put `UPLOAD_STORAGE_PATH` on shared storage before scaling out.
 */
@Injectable()
export class SharedFileService {
  private readonly logger = new Logger(SharedFileService.name);
  private readonly dir: string;

  constructor(config: ConfigService) {
    const configured =
      config.get<string>('storage.uploadsPath') ?? './storage/uploads';
    const root = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
    this.dir = join(root, 'shared');
  }

  /**
   * Validate (type, size, magic bytes) and write, returning the row metadata.
   * Three checks in message-quality order; the third is the one that matters —
   * a multipart Content-Type is written by the client, so an HTML file labelled
   * `application/pdf` would otherwise be stored and streamed back as a PDF.
   */
  async store(file: Express.Multer.File): Promise<StoredFile> {
    if (!file) throw new BadRequestException('No file was uploaded');

    const mime = (file.mimetype || '').toLowerCase();
    if (!(ALLOWED_SHARED_FILE_TYPES as readonly string[]).includes(mime)) {
      throw new UnprocessableEntityException(
        `${file.originalname || 'that file'} is not a supported format. Share a PDF or an image (PNG, JPG, WebP, GIF), or post a link instead.`,
      );
    }
    if (file.size > SHARED_FILE_MAX_BYTES) {
      throw new UnprocessableEntityException(
        `the file is ${Math.round(file.size / 1024 / 1024)} MB, over the ${Math.round(SHARED_FILE_MAX_BYTES / 1024 / 1024)} MB limit.`,
      );
    }
    if (sniffSharedFileType(file.buffer) !== mime) {
      throw new UnprocessableEntityException(
        `${file.originalname || 'that file'} is not a valid ${mime.split('/')[1].toUpperCase()}.`,
      );
    }

    await mkdir(this.dir, { recursive: true });
    const name = `${randomUUID()}.${SHARED_FILE_EXTENSION[mime] ?? 'bin'}`;
    await writeFile(join(this.dir, name), file.buffer);
    return {
      path: name,
      name: (file.originalname || 'file').slice(0, 200),
      mime,
      size: file.size,
    };
  }

  /** A read stream for a stored file. `storedPath` comes from the database,
   *  never a request, and is re-checked against the UUID shape regardless. */
  open(storedPath: string): ReadStream {
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{3,4}$/.test(storedPath)) {
      throw new NotFoundException('File not found');
    }
    return createReadStream(join(this.dir, storedPath));
  }

  /** Best-effort removal (§8.4). */
  async discard(storedPath: string | null | undefined): Promise<void> {
    if (!storedPath) return;
    try {
      await unlink(join(this.dir, storedPath));
    } catch (error) {
      this.logger.warn(
        `Shared file not removed (${storedPath}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
