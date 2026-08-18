import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { CoursesService } from './courses.service';
import {
  CourseDto,
  BulkAssignmentDto,
  CreateAssignmentDto,
  CreateLessonDto,
  ModuleDto,
  UpdateLessonDto,
} from './dto/course.dto';

@Controller('admin/courses')
@Roles('admin')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  async list() {
    return this.courses.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CourseDto) {
    return this.courses.create(dto);
  }

  @Get(':courseId')
  async get(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.courses.get(courseId);
  }

  @Put(':courseId')
  async update(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CourseDto,
  ) {
    return this.courses.update(courseId, dto);
  }

  @Delete(':courseId')
  async remove(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.courses.remove(courseId);
  }

  @Get(':courseId/modules')
  async listModules(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.courses.listModules(courseId);
  }

  @Post(':courseId/modules')
  @HttpCode(HttpStatus.CREATED)
  async createModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: ModuleDto,
  ) {
    return this.courses.createModule(courseId, dto);
  }

  @Get(':courseId/assignments')
  async listAssignments(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.courses.listAssignments(courseId);
  }

  /** Bulk assign — one statement, so a department cannot end up half-enrolled. */
  @Post(':courseId/assignments/bulk')
  @HttpCode(HttpStatus.CREATED)
  async createAssignments(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: BulkAssignmentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.courses.createAssignments(courseId, dto, admin.userId);
  }

  @Post(':courseId/assignments')
  async assign(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateAssignmentDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.courses.assign(courseId, admin.userId, dto);
    // 201 for a new assignment, 200 when an existing one was updated.
    response
      .status(result.created ? HttpStatus.CREATED : HttpStatus.OK)
      .json(result.body);
  }
}

@Controller('admin/modules')
@Roles('admin')
export class ModulesController {
  constructor(private readonly courses: CoursesService) {}

  @Put(':moduleId')
  async update(
    @Param('moduleId', ParseIntPipe) moduleId: number,
    @Body() dto: ModuleDto,
  ) {
    return this.courses.updateModule(moduleId, dto);
  }

  @Delete(':moduleId')
  async remove(@Param('moduleId', ParseIntPipe) moduleId: number) {
    return this.courses.removeModule(moduleId);
  }

  @Get(':moduleId/lessons')
  async listLessons(@Param('moduleId', ParseIntPipe) moduleId: number) {
    return this.courses.listLessons(moduleId);
  }

  @Post(':moduleId/lessons')
  @HttpCode(HttpStatus.CREATED)
  async createLesson(
    @Param('moduleId', ParseIntPipe) moduleId: number,
    @Body() dto: CreateLessonDto,
  ) {
    return this.courses.createLesson(moduleId, dto);
  }
}

@Controller('admin/lessons')
@Roles('admin')
export class LessonsController {
  constructor(private readonly courses: CoursesService) {}

  @Put(':lessonId')
  async update(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: UpdateLessonDto,
  ) {
    return this.courses.updateLesson(lessonId, dto);
  }

  @Delete(':lessonId')
  async remove(@Param('lessonId', ParseIntPipe) lessonId: number) {
    return this.courses.removeLesson(lessonId);
  }
}

@Controller('admin/assignments')
@Roles('admin')
export class AssignmentsController {
  constructor(private readonly courses: CoursesService) {}

  @Delete(':assignmentId')
  async remove(@Param('assignmentId', ParseIntPipe) assignmentId: number) {
    return this.courses.removeAssignment(assignmentId);
  }
}
