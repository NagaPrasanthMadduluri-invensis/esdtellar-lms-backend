import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { EMAIL_CONSTANTS } from '@/config/configuration';
import { PRODUCT_NAME } from '../email-brand';
import { composeMime } from './mime';
import {
  Mailer,
  MailSendError,
  type OutgoingMail,
  type SendResult,
} from './mailer.interface';

/**
 * Writes a real `.eml` to disk instead of sending.
 *
 * This is the driver that makes the feature reviewable. A `.eml` opens in
 * Thunderbird, Apple Mail or Outlook and renders through the SAME engine a
 * recipient's client would use — which catches the things a browser preview
 * never does: Outlook collapsing a padded `<a>`, a client stripping the
 * `<style>` block, a dark-mode inversion turning navy chrome muddy.
 *
 * It composes through the same `composeMime` the SES driver uses, so what
 * lands on disk is byte-for-byte what would have gone out, headers included.
 */
@Injectable()
export class FileMailerService extends Mailer {
  readonly kind = 'file' as const;
  private readonly logger = new Logger('Mailer:file');
  private readonly root: string;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    super();
    // A constant, not a variable: this driver is dev-only, so the path
    // could never legitimately differ between machines.
    const configured = EMAIL_CONSTANTS.outboxPath;
    this.root = isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
    this.from = this.config.get<string>('email.from') ?? 'no-reply@localhost';
  }

  unavailableReason(): string | null {
    return null;
  }

  async send(mail: OutgoingMail): Promise<SendResult> {
    const messageId = `file-${randomUUID()}`;
    try {
      await mkdir(this.root, { recursive: true });
      const mime = await composeMime({
        mail,
        from: this.from,
        fromName: PRODUCT_NAME,
        messageId,
      });
      // The address is in the filename so a directory listing is readable
      // without opening anything, and sanitised so a crafted local-part
      // cannot steer the write out of the directory.
      const safe = mail.to.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 60);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const path = join(this.root, `${stamp}__${safe}.eml`);
      await writeFile(path, mime);
      this.logger.log(`→ ${mail.to} :: ${mail.subject} :: ${path}`);
      return { messageId };
    } catch (error) {
      // Disk full or a bad path is genuinely transient-ish and worth
      // retrying; it is not the message being wrong.
      throw new MailSendError(
        `Could not write .eml: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }
}
