import { Module } from '@nestjs/common';

import { CertificatesModule } from '@/modules/certificates/certificates.module';

import {
  AdminAssessmentsController,
  AllAssessmentsController,
  CourseAssessmentsController,
  LearnerAssessmentsController,
  QuestionsController,
} from './assessments.controller';
import { AssessmentsRepository } from './assessments.repository';
import { AssessmentsService } from './assessments.service';
import { JourneyGateModule } from '@/modules/journeys/journey-gate.module';
import { JourneysModule } from '@/modules/journeys/journeys.module';

/** Imports CertificatesModule so a passing attempt can auto-issue a certificate. */
@Module({
  imports: [CertificatesModule, JourneysModule, JourneyGateModule],
  controllers: [
    AllAssessmentsController,
    CourseAssessmentsController,
    AdminAssessmentsController,
    QuestionsController,
    LearnerAssessmentsController,
  ],
  providers: [AssessmentsService, AssessmentsRepository],
})
export class AssessmentsModule {}
