import { Module } from '@nestjs/common';

import {
  AdminMediaController,
  AdminMediaUploadController,
} from './admin-media.controller';
import {
  LearnerMediaController,
  LearnerResourcesController,
} from './learner-media.controller';
import { MediaRepository } from './media.repository';
import { MediaService } from './media.service';
import { R2StorageService } from './storage/r2-storage.service';

/**
 * MediaService is exported so the courses module can drop a lesson's video and
 * captions when the lesson itself is deleted. The repository stays private —
 * exporting it would let another module write `lessons.video_key` without going
 * through the checks in MediaService (§3.2).
 */
@Module({
  controllers: [
    AdminMediaUploadController,
    AdminMediaController,
    LearnerMediaController,
    LearnerResourcesController,
  ],
  providers: [MediaService, MediaRepository, R2StorageService],
  /**
   * R2StorageService is exported so ScormModule's `s3` driver can reuse the one
   * configured R2 client instead of constructing a second one. It is
   * infrastructure, not a domain repository, so §3.2's "export the service,
   * never the repository" rule is satisfied — MediaRepository stays private.
   */
  exports: [MediaService, R2StorageService],
})
export class MediaModule {}
