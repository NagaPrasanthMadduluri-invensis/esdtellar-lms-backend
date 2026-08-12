import { Module } from '@nestjs/common';

import { CertificatesModule } from '@/modules/certificates/certificates.module';

import { LearnerController } from './learner.controller';
import { LearnerRepository } from './learner.repository';
import { LearnerService } from './learner.service';

/** Imports CertificatesModule so completing a lesson can auto-issue. */
@Module({
  imports: [CertificatesModule],
  controllers: [LearnerController],
  providers: [LearnerService, LearnerRepository],
})
export class LearnerModule {}
