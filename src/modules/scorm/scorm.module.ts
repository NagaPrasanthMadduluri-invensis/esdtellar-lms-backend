import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { CertificatesModule } from '@/modules/certificates/certificates.module';

import { EntitlementCache } from './entitlement-cache';
import { AdminScormController, LearnerScormController } from './scorm.controller';
import { ScormContentMiddleware } from './scorm-content.middleware';
import { ScormRepository } from './scorm.repository';
import { ScormService } from './scorm.service';
import { ScormStorageService } from './storage/scorm-storage.service';

/**
 * ScormStorageService and ScormContentMiddleware are both exported so
 * main.ts can wire them up by hand: the middleware authenticates every
 * `/scorm` request, and ScormStorageService's root path is what it (and
 * `useStaticAssets`, mounted right after it) serves from.
 */
@Module({
  imports: [AuthModule, CertificatesModule],
  controllers: [AdminScormController, LearnerScormController],
  providers: [
    ScormService,
    ScormRepository,
    ScormStorageService,
    EntitlementCache,
    ScormContentMiddleware,
  ],
  exports: [ScormStorageService, ScormContentMiddleware, ScormService],
})
export class ScormModule {}
