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

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { ChangePasswordDto } from './dto/change-password.dto';
import { LearnerService } from './learner.service';

@Controller('learner')
@Roles('learner')
export class LearnerController {
  constructor(private readonly learner: LearnerService) {}

  @Get('dashboard')
  async dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.learner.dashboard(user.userId);
  }

  @Get('courses')
  async courses(@CurrentUser() user: AuthenticatedUser) {
    return this.learner.courses(user.userId);
  }

  @Get('courses/:courseId')
  async courseDetail(
    @Param('courseId', ParseIntPipe) courseId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.learner.courseDetail(user.userId, courseId);
  }

  @Get('lessons/:lessonId')
  async lesson(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.learner.lesson(user.userId, lessonId);
  }

  @Post('lessons/:lessonId/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.learner.completeLesson(user.userId, lessonId);
  }

  @Get('progress')
  async progress(@CurrentUser() user: AuthenticatedUser) {
    return this.learner.progress(user.userId);
  }

  @Get('achievements')
  async achievements(@CurrentUser() user: AuthenticatedUser) {
    return this.learner.achievements(user.userId);
  }

  @Get('leaderboard')
  async leaderboard(@CurrentUser() user: AuthenticatedUser) {
    return this.learner.leaderboard(user.userId);
  }

  @Get('learning-hours')
  async learningHours(@CurrentUser() user: AuthenticatedUser) {
    return this.learner.learningHours(user.userId);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.learner.changePassword(user.userId, dto);
  }
}
