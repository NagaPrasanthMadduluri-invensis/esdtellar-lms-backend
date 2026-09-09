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

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
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

  /**
   * The manager's Team Learning module (decision 2 — no separate portal, one
   * extra module in the learner portal).
   *
   * `@Permissions('view_team_learning')` is the gate: a plain learner holds no
   * permissions and gets 403, a manager holds this one and gets their
   * department. The screen this replaces was a hardcoded array shown to
   * everybody.
   */
  @Get('team')
  @Permissions('view_team_learning')
  async team(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.learner.team(scope, user.userId);
  }

  /*
   * `change-password` moved to `POST /api/auth/change-password`.
   *
   * It sat here on a `@Roles('learner')` controller, so a trainer — who needs
   * it just as much — got 403 from the only screen that offers it. Changing
   * your own password is not learner work; it is auth work. One route now,
   * reachable by every authenticated role (`specs/rbac.md` §8.3).
   */
}
