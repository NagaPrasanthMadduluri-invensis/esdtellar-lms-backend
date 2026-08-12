import { mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AdmZip from 'adm-zip';

/**
 * Owns SCORM package files on disk.
 *
 * Every call site goes through this service rather than touching `fs` directly,
 * so swapping the local driver for S3/R2 later is a change to this file plus a
 * sibling implementation — no controller, service or query changes. The
 * `driver` config value already exists for that switch.
 */
@Injectable()
export class ScormStorageService {
  private readonly logger = new Logger(ScormStorageService.name);
  private readonly root: string;

  constructor(config: ConfigService) {
    const configured = config.getOrThrow<string>('storage.localPath');
    this.root = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
  }

  /** Absolute path of the storage root — used to mount static serving. */
  get rootPath(): string {
    return this.root;
  }

  directoryFor(packageDir: string): string {
    return join(this.root, packageDir);
  }

  /**
   * Extracts a package zip into its own directory.
   * Returns the manifest XML, or null when the archive has no imsmanifest.xml.
   */
  async extract(packageDir: string, buffer: Buffer): Promise<string | null> {
    const target = this.directoryFor(packageDir);
    await mkdir(target, { recursive: true });

    const zip = new AdmZip(buffer);
    zip.extractAllTo(target, true);

    const manifestPath = join(target, 'imsmanifest.xml');
    if (!existsSync(manifestPath)) {
      await this.remove(packageDir);
      return null;
    }
    return readFileSync(manifestPath, 'utf-8');
  }

  /** Best-effort delete — a missing directory is not an error. */
  async remove(packageDir: string): Promise<void> {
    try {
      await rm(this.directoryFor(packageDir), { recursive: true, force: true });
    } catch (error) {
      this.logger.warn(
        `Could not remove SCORM directory ${packageDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
