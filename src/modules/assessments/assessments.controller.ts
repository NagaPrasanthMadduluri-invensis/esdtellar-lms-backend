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
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { AssessmentsService } from './assessments.service';
import {
  AssessmentDto,
  QuestionDto,
  SubmitAttemptDto,
} from './dto/assessment.dto';

/** `/api/admin/all-assessments` — flat list across every course. */
@Controller('admin/all-assessments')
@Roles('admin')
export class AllAssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get()
  async list(@CurrentScope() scope: OrgScope) {
    return this.assessments.listAll(scope);
  }
}

@Controller('admin/courses/:courseId/assessments')
@Roles('admin')
export class CourseAssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get()
  async list(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.listByCourse(scope, courseId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: AssessmentDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.create(scope, courseId, dto);
  }
}

@Controller('admin/assessments')
@Roles('admin')
export class AdminAssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get(':assessmentId')
  async get(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.getForAdmin(scope, assessmentId);
  }

  @Put(':assessmentId')
  async update(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() dto: AssessmentDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.update(scope, assessmentId, dto);
  }

  /**
   * Attach to / detach from the course. Symmetric with the SCORM assign routes:
   * the verb is the method, so the two states are greppable rather than hidden
   * behind a boolean in an update payload.
   */
  @Post(':assessmentId/attach')
  @HttpCode(HttpStatus.OK)
  async attach(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.setAttached(scope, assessmentId, true);
  }

  @Delete(':assessmentId/attach')
  async detach(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.setAttached(scope, assessmentId, false);
  }

  @Delete(':assessmentId')
  async remove(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.remove(scope, assessmentId);
  }

  @Post(':assessmentId/questions')
  @HttpCode(HttpStatus.CREATED)
  async addQuestion(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() dto: QuestionDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.addQuestion(scope, assessmentId, dto);
  }
}

@Controller('admin/questions')
@Roles('admin')
export class QuestionsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Put(':questionId')
  async update(
    @Param('questionId', ParseIntPipe) questionId: number,
    @Body() dto: QuestionDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.updateQuestion(scope, questionId, dto);
  }

  @Delete(':questionId')
  async remove(
    @Param('questionId', ParseIntPipe) questionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.removeQuestion(scope, questionId);
  }
}

@Controller('learner/assessments')
@Roles('learner')
export class LearnerAssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.listForLearner(scope, user.userId);
  }

  @Get(':assessmentId')
  async get(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.getForLearner(scope, assessmentId, user.userId);
  }

  @Get(':assessmentId/attempts')
  async attempts(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.listAttempts(scope, assessmentId, user.userId);
  }

  @Post(':assessmentId/attempt')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() dto: SubmitAttemptDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.assessments.submitAttempt(scope, assessmentId, user.userId, dto);
  }
}
