import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { type OrgScope } from '@/database/org-scope';

import { CatalogueService } from './catalogue.service';

/**
 * The Course Catalogue — the learner's own side, and the only side there is.
 *
 * `@Roles('learner')` and no `@Permissions()`: joining something your
 * organization has deliberately opened to everybody is not a capability that
 * organization then withholds from individuals. A Manager rides in the
 * learner portal (rbac.md decision 2) and reaches this too, which is correct
 * — they take courses like anybody else.
 *
 * NO ROUTE TAKES A USER ID. Who is enrolling comes from the verified token,
 * so there is no parameter through which one learner could book a colleague
 * onto a session, and the roster cannot be written from here in anybody
 * else's name.
 *
 * The admin side of this feature is two toggles on forms that already exist
 * (`courses.self_enrol`, `sessions.enroll_mode`), not a controller — which is
 * why there is no `admin-catalogue.controller.ts` beside this one.
 */
@Controller('learner/catalogue')
@Roles('learner')
export class LearnerCatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  /** Everything open to this learner, with their own state on each row. */
  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.catalogue.list(scope, user.userId);
  }

  /**
   * Add an open course to my learning. 200, not 201 — it is idempotent, and
   * a learner pressing it twice has created one assignment.
   */
  @Post('courses/:courseId/enrol')
  @HttpCode(200)
  async enrolCourse(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('courseId', ParseIntPipe) courseId: number,
  ) {
    return this.catalogue.enrolCourse(scope, courseId, user);
  }

  /** Book a place, or join the queue when the session is full. */
  @Post('sessions/:sessionId/enrol')
  @HttpCode(200)
  async enrolSession(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseIntPipe) sessionId: number,
  ) {
    return this.catalogue.enrolSession(scope, sessionId, user);
  }

  /**
   * Give up a place, or leave the queue.
   *
   * SESSIONS ONLY, and there is deliberately no course equivalent: leaving a
   * course would delete lesson completions the learner has genuinely earned,
   * with no undo and no admin in the loop. A session that has not happened
   * has nothing to lose, and the service refuses once attendance is marked.
   */
  @Delete('sessions/:sessionId/enrol')
  async leaveSession(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', ParseIntPipe) sessionId: number,
  ) {
    return this.catalogue.leaveSession(scope, sessionId, user);
  }
}
