import { Module } from '@nestjs/common';

import { MediaModule } from '@/modules/media/media.module';

import {
  AssignmentsController,
  CoursesController,
  LessonsController,
  ModulesController,
  ResourcesController,
} from './courses.controller';
import { CoursesRepository } from './courses.repository';
import { CoursesService } from './courses.service';

@Module({
  imports: [MediaModule],
  controllers: [
    CoursesController,
    ModulesController,
    LessonsController,
    ResourcesController,
    AssignmentsController,
  ],
  providers: [CoursesService, CoursesRepository],
  exports: [CoursesService],
})
export class CoursesModule {}
