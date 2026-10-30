import { Module } from '@nestjs/common';

import { SharedFileService } from './shared-file.service';

/**
 * The shared file store for things people share with each other — community
 * Resources and direct-message attachments. Dependency-free (like
 * NotificationsModule), so any feature module can import it without a cycle.
 */
@Module({
  providers: [SharedFileService],
  exports: [SharedFileService],
})
export class FilesModule {}
