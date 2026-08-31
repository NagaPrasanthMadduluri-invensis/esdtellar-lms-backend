import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { ChangePasswordDto } from './dto/change-password.dto';
import { LearnerService } from './learner.service';

@Controller('learner')
@Roles('learner')
export class LearnerController {
  constructor(private readonly learner: LearnerService) {}

  @Get('dashboard')
  async dashboard(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.dashboard(scope, user.userId);
  }

  @Get('courses')
  async courses(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.courses(scope, user.userId);
  }

  @Get('courses/:courseId')
  async courseDetail(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.courseDetail(scope, user.userId, courseId);
  }

  @Get('lessons/:lessonId')
  async lesson(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.lesson(scope, user.userId, lessonId);
  }

  @Post('lessons/:lessonId/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.completeLesson(scope, user.userId, lessonId);
  }

  @Get('progress')
  async progress(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.progress(scope, user.userId);
  }

  @Get('achievements')
  async achievements(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.achievements(scope, user.userId);
  }

  @Get('leaderboard')
  async leaderboard(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.leaderboard(scope, user.userId);
  }

  @Get('learning-hours')
  async learningHours(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.learningHours(scope, user.userId);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.changePassword(scope, user.userId, dto);
  }
}
