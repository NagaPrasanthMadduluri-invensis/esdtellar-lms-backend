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

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

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
  async list() {
    return this.assessments.listAll();
  }
}

@Controller('admin/courses/:courseId/assessments')
@Roles('admin')
export class CourseAssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get()
  async list(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.assessments.listByCourse(courseId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: AssessmentDto,
  ) {
    return this.assessments.create(courseId, dto);
  }
}

@Controller('admin/assessments')
@Roles('admin')
export class AdminAssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get(':assessmentId')
  async get(@Param('assessmentId', ParseIntPipe) assessmentId: number) {
    return this.assessments.getForAdmin(assessmentId);
  }

  @Put(':assessmentId')
  async update(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() dto: AssessmentDto,
  ) {
    return this.assessments.update(assessmentId, dto);
  }

  /**
   * Attach to / detach from the course. Symmetric with the SCORM assign routes:
   * the verb is the method, so the two states are greppable rather than hidden
   * behind a boolean in an update payload.
   */
  @Post(':assessmentId/attach')
  @HttpCode(HttpStatus.OK)
  async attach(@Param('assessmentId', ParseIntPipe) assessmentId: number) {
    return this.assessments.setAttached(assessmentId, true);
  }

  @Delete(':assessmentId/attach')
  async detach(@Param('assessmentId', ParseIntPipe) assessmentId: number) {
    return this.assessments.setAttached(assessmentId, false);
  }

  @Delete(':assessmentId')
  async remove(@Param('assessmentId', ParseIntPipe) assessmentId: number) {
    return this.assessments.remove(assessmentId);
  }

  @Post(':assessmentId/questions')
  @HttpCode(HttpStatus.CREATED)
  async addQuestion(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() dto: QuestionDto,
  ) {
    return this.assessments.addQuestion(assessmentId, dto);
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
  ) {
    return this.assessments.updateQuestion(questionId, dto);
  }

  @Delete(':questionId')
  async remove(@Param('questionId', ParseIntPipe) questionId: number) {
    return this.assessments.removeQuestion(questionId);
  }
}

@Controller('learner/assessments')
@Roles('learner')
export class LearnerAssessmentsController {
  constructor(private readonly assessments: AssessmentsService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.assessments.listForLearner(user.userId);
  }

  @Get(':assessmentId')
  async get(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assessments.getForLearner(assessmentId, user.userId);
  }

  @Get(':assessmentId/attempts')
  async attempts(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assessments.listAttempts(assessmentId, user.userId);
  }

  @Post(':assessmentId/attempt')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Param('assessmentId', ParseIntPipe) assessmentId: number,
    @Body() dto: SubmitAttemptDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assessments.submitAttempt(assessmentId, user.userId, dto);
  }
}
