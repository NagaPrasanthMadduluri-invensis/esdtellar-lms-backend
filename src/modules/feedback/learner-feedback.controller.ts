import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';

import { SubmitFeedbackDto } from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';

/**
 * The learner's side: rate a session you attended.
 *
 * `@Roles('learner')` and no `@Permissions()`. Rating a session you sat in is
 * not a capability an organization grants or withholds — it is the same
 * reasoning the notification bell uses. A Manager rides in the learner portal
 * (rbac.md decision 2) and reaches this too, which is correct: they attend
 * sessions like anybody else.
 *
 * NOTHING here takes a user id. The author comes from the verified token, so
 * there is no parameter through which one learner could file feedback in
 * another's name — the same rule §10.14 applies to service requests, and it
 * matters more here because the row is anonymous downstream: a forged author
 * would be untraceable by design.
 */
@Controller('learner/feedback')
@Roles('learner')
export class LearnerFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** Completed sessions this learner attended, and what they said about each. */
  @Get('sessions')
  async sessions(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.feedback.listForLearner(scope, user.userId);
  }

  /**
   * Submit or revise a rating. 200, not 201: the row is an upsert, and a
   * learner correcting their own answer has not created anything.
   */
  @Post('sessions/:sessionId')
  async submit(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: SubmitFeedbackDto,
  ) {
    return this.feedback.submit(scope, sessionId, user, dto);
  }
}
