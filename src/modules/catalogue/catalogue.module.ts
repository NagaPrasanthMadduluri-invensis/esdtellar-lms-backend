import { Module } from '@nestjs/common';

import { CoursesModule } from '@/modules/courses/courses.module';
import { SessionsModule } from '@/modules/sessions/sessions.module';

import { CatalogueRepository } from './catalogue.repository';
import { CatalogueService } from './catalogue.service';
import { LearnerCatalogueController } from './learner-catalogue.controller';

/**
 * The Course Catalogue (0035): what a learner may add to their own learning.
 *
 * It composes rather than duplicates. The list is its own query — neither
 * Courses nor Sessions can answer half of it — but every WRITE delegates to
 * the service that owns the rule, so there is still exactly one place that
 * knows a roster row implies a training assignment and one that knows an
 * assignment clears the journey gate.
 *
 * Nothing imports this module, so the two it imports cannot become a cycle.
 */
@Module({
  imports: [CoursesModule, SessionsModule],
  controllers: [LearnerCatalogueController],
  providers: [CatalogueService, CatalogueRepository],
})
export class CatalogueModule {}
