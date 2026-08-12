import { Module } from '@nestjs/common';

import { AdminCertificatesController } from './admin-certificates.controller';
import { CertificatesRepository } from './certificates.repository';
import { CertificatesService } from './certificates.service';
import { LearnerCertificatesController } from './learner-certificates.controller';
import { PublicCertificatesController } from './public-certificates.controller';

/**
 * CertificatesService is exported so the lessons and assessments modules can
 * call `autoIssue()` when a learner completes a course. That is the only
 * cross-module dependency certificates has.
 */
@Module({
  controllers: [
    LearnerCertificatesController,
    AdminCertificatesController,
    PublicCertificatesController,
  ],
  providers: [CertificatesService, CertificatesRepository],
  exports: [CertificatesService],
})
export class CertificatesModule {}
