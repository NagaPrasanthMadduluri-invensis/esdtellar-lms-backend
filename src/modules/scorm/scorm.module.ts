import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { OrganizationsModule } from '../organizations/organizations.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { CertificatesModule } from '@/modules/certificates/certificates.module';
import { MediaModule } from '@/modules/media/media.module';
import { R2StorageService } from '@/modules/media/storage/r2-storage.service';

import { EntitlementCache } from './entitlement-cache';
import { AdminScormController, LearnerScormController } from './scorm.controller';
import { ScormContentHandler } from './scorm-content.handler';
import { ScormContentMiddleware } from './scorm-content.middleware';
import { ScormDatamodelRepository } from './scorm-datamodel.repository';
import { ScormRepository } from './scorm.repository';
import { ScormService } from './scorm.service';
import { S3ScormStorageDriver } from './storage/s3-scorm-storage.driver';
import { SCORM_STORAGE_DRIVER } from './storage/scorm-storage.driver';
import { ScormStorageService } from './storage/scorm-storage.service';
import { JourneyGateModule } from '@/modules/journeys/journey-gate.module';
import { JourneysModule } from '@/modules/journeys/journeys.module';

/**
 * ScormStorageService, ScormContentMiddleware and ScormContentHandler are all
 * exported so `main.ts` can wire them by hand: the middleware authenticates
 * every `/scorm` request, and what serves the bytes afterwards depends on the
 * driver — `useStaticAssets` for `local`, `ScormContentHandler` for `s3`.
 *
 * MediaModule is imported for `R2StorageService`. Reusing it rather than
 * constructing a second `S3Client` keeps R2 credentials, the path-style
 * addressing requirement and the `requestChecksumCalculation` presign trap in
 * one file — two clients would mean two places to fix the next such quirk.
 * No cycle: MediaModule does not import ScormModule.
 */
@Module({
  imports: [
    AuthModule,
    CertificatesModule,
    OrganizationsModule,
    MediaModule, JourneysModule, JourneyGateModule],
  controllers: [AdminScormController, LearnerScormController],
  providers: [
    ScormService,
    ScormRepository,
    ScormDatamodelRepository,
    ScormStorageService,
    ScormContentHandler,
    EntitlementCache,
    ScormContentMiddleware,
    S3ScormStorageDriver,
    {
      /**
       * ONE driver. There is no `SCORM_STORAGE_DRIVER` switch any more.
       *
       * The local-disk driver pinned the API to a single instance — a second
       * process could not see packages the first had extracted — and every
       * package now lives in R2. Keeping a disabled code path around would
       * have meant a typo in an env var silently writing new uploads to a
       * disk nothing serves.
       *
       * The consequence is deliberate and worth stating: R2 is now a HARD
       * DEPENDENCY for SCORM. Misconfigure it and SCORM returns 503 for
       * everyone rather than quietly falling back, which is the point — a
       * silent fallback is how nobody finds out object storage is broken.
       */
      provide: SCORM_STORAGE_DRIVER,
      inject: [S3ScormStorageDriver],
      useFactory: (s3: S3ScormStorageDriver) => s3,
    },
  ],
  exports: [
    ScormStorageService,
    ScormContentMiddleware,
    ScormContentHandler,
    ScormService,
  ],
})
export class ScormModule {}
