import { Module } from '@nestjs/common';

import { ActivityModule } from '@/modules/activity/activity.module';

import { ScormModule } from '../scorm/scorm.module';
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
  imports: [ActivityModule, MediaModule, ScormModule],
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
