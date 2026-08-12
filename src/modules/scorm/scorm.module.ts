import { Module } from '@nestjs/common';

import { CertificatesModule } from '@/modules/certificates/certificates.module';

import { AdminScormController, LearnerScormController } from './scorm.controller';
import { ScormRepository } from './scorm.repository';
import { ScormService } from './scorm.service';
import { ScormStorageService } from './storage/scorm-storage.service';

/**
 * ScormStorageService is exported so main.ts can mount the extracted package
 * directories for static serving.
 */
@Module({
  imports: [CertificatesModule],
  controllers: [AdminScormController, LearnerScormController],
  providers: [ScormService, ScormRepository, ScormStorageService],
  exports: [ScormStorageService],
})
export class ScormModule {}
