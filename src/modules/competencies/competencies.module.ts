import { Module } from '@nestjs/common';

import { CertificatesModule } from '@/modules/certificates/certificates.module';

import { AdminSkillsController } from './admin-skills.controller';
import { CompetenciesRepository } from './competencies.repository';
import { CompetenciesService } from './competencies.service';
import { LearnerCompetenciesController } from './learner-competencies.controller';

/**
 * The competency foundation (0070, spec ai-insights.md Wave 0).
 *
 * Imports `CertificatesModule` to re-use the single completion definition when
 * recording a learner's gained skills — never a second one. Exports its service
 * so the three completion seams (scorm, assessments, learner) can call
 * `onCourseCompleted()` beside `autoIssue` and `onCourseProgress`.
 */
@Module({
  imports: [CertificatesModule],
  controllers: [AdminSkillsController, LearnerCompetenciesController],
  providers: [CompetenciesService, CompetenciesRepository],
  exports: [CompetenciesService],
})
export class CompetenciesModule {}
