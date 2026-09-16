import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  CurrentScope,
  CurrentUser,
  Permissions,
  Roles,
} from '@/common/decorators';
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
  BulkCourseActionDto,
  CourseListQueryDto,
  LinkLessonDto,
} from './dto/course.dto';

@Controller('admin/courses')
@Roles('admin')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @Query() query: CourseListQueryDto,
  ) {
    return this.courses.list(scope, query.archived ?? false);
  }

  /**
   * Archive / restore / publish / unpublish, over a selection.
   *
   * Declared before `:courseId` — Nest matches in declaration order, so a
   * literal segment after a parameter one is swallowed by it.
   *
   * `manage_courses`, the same permission a single edit needs: doing twenty at
   * once is not a different capability from doing one.
   */
  /**
   * Every lesson on a course — placed and staged — for the authoring page.
   * Declared before `:courseId` routes that could swallow it is unnecessary
   * here (the literal is deeper in the path), but the order still matters for
   * `bulk` above.
   */
  @Get(':courseId/lessons')
  async courseLessons(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.listCourseLessons(scope, courseId);
  }

  /**
   * Create a lesson at COURSE level. `module_id` in the body places it
   * straight away; omitted, it is staged until linked.
   */
  @Post(':courseId/lessons')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_courses')
  async createCourseLesson(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CreateLessonDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.createCourseLesson(scope, courseId, dto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @Permissions('manage_courses')
  async bulk(
    @Body() dto: BulkCourseActionDto,
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.courses.bulk(scope, dto, admin);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_courses')
  async create(
    @Body() dto: CourseDto,
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.courses.create(scope, dto, admin);
  }

  @Get(':courseId')
  async get(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.get(scope, courseId);
  }

  @Put(':courseId')
  @Permissions('manage_courses')
  async update(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: CourseDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.update(scope, courseId, dto);
  }

  @Delete(':courseId')
  @Permissions('manage_courses')
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
  @Permissions('manage_courses')
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
  @Permissions('assign_learning')
  async createAssignments(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: BulkAssignmentDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.createAssignments(scope, courseId, dto, admin.userId, admin);
  }

  @Post(':courseId/assignments')
  @Permissions('assign_learning')
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
  @Permissions('manage_courses')
  async update(
    @Param('moduleId', ParseIntPipe) moduleId: number,
    @Body() dto: ModuleDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.updateModule(scope, moduleId, dto);
  }

  @Delete(':moduleId')
  @Permissions('manage_courses')
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
  @Permissions('manage_courses')
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
  @Permissions('manage_courses')
  async update(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: UpdateLessonDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.updateLesson(scope, lessonId, dto);
  }

  /**
   * Move a lesson into a module, or back to staged (`module_id: null`).
   *
   * PATCH, not PUT: this changes one relationship and leaves the lesson's
   * content untouched, so a caller that sends only this cannot blank a field
   * it did not mention.
   */
  @Patch(':lessonId/module')
  @Permissions('manage_courses')
  async link(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: LinkLessonDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.setLessonModule(scope, lessonId, dto.module_id ?? null);
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
  @Permissions('manage_courses')
  async createResource(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: CreateResourceDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.createResource(scope, lessonId, dto);
  }

  @Delete(':lessonId')
  @Permissions('manage_courses')
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
  @Permissions('manage_courses')
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
  @Permissions('assign_learning')
  async remove(
    @Param('assignmentId', ParseIntPipe) assignmentId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.courses.removeAssignment(scope, assignmentId);
  }
}
