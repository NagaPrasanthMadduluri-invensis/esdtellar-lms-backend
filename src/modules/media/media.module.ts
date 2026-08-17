import { Module } from '@nestjs/common';

import {
  AdminMediaController,
  AdminMediaUploadController,
} from './admin-media.controller';
import { LearnerMediaController } from './learner-media.controller';
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
  ],
  providers: [MediaService, MediaRepository, R2StorageService],
  exports: [MediaService],
})
export class MediaModule {}
