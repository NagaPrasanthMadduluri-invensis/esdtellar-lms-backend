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

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { CoursesService } from './courses.service';
import {
  CourseDto,
  BulkAssignmentDto,
  CreateAssignmentDto,
  CreateLessonDto,
  ModuleDto,
  UpdateLessonDto,
  CreateResourceDto,
} from './dto/course.dto';

@Controller('admin/courses')
@Roles('admin')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  async list(@CurrentScope() scope: OrgScope) {
    return this.courses.list(scope);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CourseDto, @CurrentScope() scope: OrgScope) {
    return this.courses.create(scope, dto);
  }

  @Get(':courseId')
  async get(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.get(scope, courseId);
  }

  @Put(':courseId')
  async update(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CourseDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.update(scope, courseId, dto);
  }

  @Delete(':courseId')
  async remove(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.remove(scope, courseId);
  }

  @Get(':courseId/modules')
  async listModules(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.listModules(scope, courseId);
  }

  @Post(':courseId/modules')
  @HttpCode(HttpStatus.CREATED)
  async createModule(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: ModuleDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.createModule(scope, courseId, dto);
  }

  @Get(':courseId/assignments')
  async listAssignments(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.listAssignments(scope, courseId);
  }

  /** Bulk assign — one statement, so a department cannot end up half-enrolled. */
  @Post(':courseId/assignments/bulk')
  @HttpCode(HttpStatus.CREATED)
  async createAssignments(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: BulkAssignmentDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.createAssignments(scope, courseId, dto, admin.userId);
  }

  @Post(':courseId/assignments')
  async assign(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateAssignmentDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.courses.assign(scope, courseId, admin.userId, dto);
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
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.updateModule(scope, moduleId, dto);
  }

  @Delete(':moduleId')
  async remove(
    @Param('moduleId', ParseIntPipe) moduleId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.removeModule(scope, moduleId);
  }

  @Get(':moduleId/lessons')
  async listLessons(
    @Param('moduleId', ParseIntPipe) moduleId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.listLessons(scope, moduleId);
  }

  @Post(':moduleId/lessons')
  @HttpCode(HttpStatus.CREATED)
  async createLesson(
    @Param('moduleId', ParseIntPipe) moduleId: number,
    @Body() dto: CreateLessonDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.createLesson(scope, moduleId, dto);
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
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.updateLesson(scope, lessonId, dto);
  }

  /* ── Supporting resources ──
     Attached to a lesson alongside its primary content. Reference material —
     they carry no duration and never reach learning hours. */

  @Get(':lessonId/resources')
  async listResources(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.listResources(scope, lessonId);
  }

  @Post(':lessonId/resources')
  @HttpCode(HttpStatus.CREATED)
  async createResource(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: CreateResourceDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.createResource(scope, lessonId, dto);
  }

  @Delete(':lessonId')
  async remove(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.removeLesson(scope, lessonId);
  }
}

/** Its own base path so a resource id is never read as an assignment id. */
@Controller('admin/resources')
@Roles('admin')
export class ResourcesController {
  constructor(private readonly courses: CoursesService) {}

  @Delete(':resourceId')
  async remove(
    @Param('resourceId', ParseIntPipe) resourceId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.removeResource(scope, resourceId);
  }
}

@Controller('admin/assignments')
@Roles('admin')
export class AssignmentsController {
  constructor(private readonly courses: CoursesService) {}

  @Delete(':assignmentId')
  async remove(
    @Param('assignmentId', ParseIntPipe) assignmentId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.removeAssignment(scope, assignmentId);
  }
}
