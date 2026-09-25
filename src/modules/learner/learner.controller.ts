import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { SpreadsheetService } from '@/modules/reports/spreadsheet.service';

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { ChangePasswordDto } from './dto/change-password.dto';
import { LearnerService } from './learner.service';

@Controller('learner')
@Roles('learner')
export class LearnerController {
  constructor(private readonly learner: LearnerService,
    private readonly spreadsheets: SpreadsheetService,
  ) {}

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

  /**
   * `POST /api/learner/team/:userId/nudge` — prod one report.
   *
   * Same permission as reading the team, deliberately: a manager who can see
   * that somebody is behind can say so. A separate permission would be one
   * nobody would think to grant, leaving a button that always 403s.
   *
   * The path id is checked against the caller's OWN reports in the service,
   * so it cannot be swapped for a colleague's.
   */
  /**
   * `POST /api/learner/team/export` — the team as an .xlsx.
   *
   * POST rather than GET, and a separate route rather than a `format` flag on
   * the read: the response is a binary stream with its own headers and an
   * `@Res()` handler, and folding that into a route that usually returns JSON
   * gives one method two contradictory return types (§10.12).
   *
   * It rebuilds the report through the same service the screen reads, so the
   * file can never describe a different team from the one on screen.
   */
  @Post('team/export')
  @Permissions('view_team_learning')
  async exportTeam(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.learner.teamWorkbook(
      scope,
      user.userId,
      user,
    );
    this.spreadsheets.send(response, buffer, filename);
  }

  @Post('team/:userId/nudge')
  @HttpCode(HttpStatus.OK)
  @Permissions('view_team_learning')
  async nudge(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.learner.nudge(scope, user.userId, userId, user);
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
