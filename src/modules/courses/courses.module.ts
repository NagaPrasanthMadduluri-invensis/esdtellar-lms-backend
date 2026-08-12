import { Module } from '@nestjs/common';

import {
  AssignmentsController,
  CoursesController,
  LessonsController,
  ModulesController,
} from './courses.controller';
import { CoursesRepository } from './courses.repository';
import { CoursesService } from './courses.service';

@Module({
  controllers: [
    CoursesController,
    ModulesController,
    LessonsController,
    AssignmentsController,
  ],
  providers: [CoursesService, CoursesRepository],
  exports: [CoursesService],
})
export class CoursesModule {}
