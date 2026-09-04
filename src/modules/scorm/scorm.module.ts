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
import { LocalScormStorageDriver } from './storage/local-scorm-storage.driver';
import { S3ScormStorageDriver } from './storage/s3-scorm-storage.driver';
import { SCORM_STORAGE_DRIVER } from './storage/scorm-storage.driver';
import { ScormStorageService } from './storage/scorm-storage.service';

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
    MediaModule,
  ],
  controllers: [AdminScormController, LearnerScormController],
  providers: [
    ScormService,
    ScormRepository,
    ScormDatamodelRepository,
    ScormStorageService,
    ScormContentHandler,
    EntitlementCache,
    ScormContentMiddleware,
    LocalScormStorageDriver,
    S3ScormStorageDriver,
    {
      /**
       * The `SCORM_STORAGE_DRIVER` switch, resolved once at boot.
       *
       * An unrecognised value falls back to `local` with a loud log rather than
       * throwing: a typo in this variable should not take down an LMS whose
       * only affected feature is SCORM, and silently writing packages to a
       * different backing store than the operator asked for is exactly what
       * `ScormStorageService`'s constructor cross-check catches.
       */
      provide: SCORM_STORAGE_DRIVER,
      inject: [ConfigService, LocalScormStorageDriver, S3ScormStorageDriver],
      useFactory: (
        config: ConfigService,
        local: LocalScormStorageDriver,
        s3: S3ScormStorageDriver,
      ) => (config.get<string>('storage.driver') === 's3' ? s3 : local),
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
