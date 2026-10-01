import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';

import { SubmitCourseFeedbackDto } from './dto/survey.dto';
import { SurveysService } from './surveys.service';

/**
 * "Which of my courses still want an opinion?" — one read, for the learner
 * dashboard's prompt.
 *
 * A second controller rather than a route on the one below, because that one
 * is mounted under `learner/courses/:courseId/feedback` and this question is
 * not about a course id. Same audience, same service.
 */
@Controller('learner/surveys')
@Roles('learner')
export class LearnerSurveyListController {
  constructor(private readonly surveys: SurveysService) {}

  /** Finished courses this learner has not rated. Empty is a real answer. */
  /**
   * The learner's whole course-feedback inbox — owed and already sent.
   * `pending` beside it is the same data narrowed, for the dashboard panel.
   */
  @Get()
  async mine(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.surveys.listForLearner(scope, user.userId);
  }

  @Get('pending')
  async pending(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.surveys.pendingForLearner(scope, user.userId);
  }
}

/**
 * The learner's side: say what you thought of a course.
 *
 * `@Roles('learner')` and no `@Permissions()`, the same reasoning the session
 * feedback controller gives — rating a course you were assigned is not a
 * capability an organization grants or withholds.
 *
 * NO ROUTE TAKES A USER ID. The author comes from the verified token, so
 * there is no parameter through which one learner could file feedback in
 * another's name.
 *
 * And nothing here writes a completion. Giving feedback does not advance a
 * course, and refusing to give it does not hold one back.
 */
@Controller('learner/courses/:courseId/feedback')
@Roles('learner')
export class LearnerSurveysController {
  constructor(private readonly surveys: SurveysService) {}

  /** The form this course asks, plus what I already said. */
  @Get()
  async form(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    return this.surveys.formForLearner(scope, courseId, user.userId);
  }

  /**
   * Submit or revise. 200, not 201 — the row is an upsert and a learner
   * correcting their own answer has created nothing. Nest defaults a POST to
   * 201, so the code is explicit (§8.2), exactly as session feedback is.
   */
  @Post()
  @HttpCode(200)
  async submit(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseIntPipe) courseId: number,
    @Body() dto: SubmitCourseFeedbackDto,
  ) {
    return this.surveys.submit(scope, courseId, user, dto);
  }
}
