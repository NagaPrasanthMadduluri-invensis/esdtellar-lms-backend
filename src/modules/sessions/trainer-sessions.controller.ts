import { Body, Controller, Get, Param, ParseIntPipe, Put } from '@nestjs/common';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { SaveAttendanceDto } from './dto/session.dto';
import { SessionsService } from './sessions.service';

/**
 * The trainer's view of sessions — `specs/rbac.md` §3.6.1.
 *
 * A separate controller per audience, per `BACKEND_STRUCTURE.md` §2.2: the
 * audience is visible in the file name and enforced by one class-level
 * decorator, rather than by an `if (role === ...)` inside handlers that
 * someone can forget.
 *
 * `@Roles('trainer')` is the first of two layers. The second is that every
 * service method takes the caller's `userId` and filters
 * `trainer_user_id = <that>` in SQL, so a trainer cannot reach another
 * trainer's session even with a guessed id — and cannot reach it before
 * `PermissionsGuard` exists at all, which is why this portal ships ahead of
 * the `permissions[]` claim.
 *
 * NOTE what is absent, and deliberately so (decisions 7 and 8): there is no
 * complete route and no roster route. Completing a session credits every
 * attendee with the training, its learning hours and its completion; adding a
 * participant creates a course assignment for them. Both stay with an org
 * admin, and the trainer has no endpoint to reach rather than a guard to fail.
 */
@Controller('trainer/sessions')
@Roles('trainer')
export class TrainerSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /** His own sessions, newest first. */
  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sessions.listForTrainer(scope, user.userId);
  }

  /** One session with its companion course. 404 when it is not his. */
  @Get(':id')
  async get(
    @Param('id', ParseIntPipe) id: number,
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sessions.trainerSession(scope, id, user.userId);
  }

  /** The roster with each learner's attendance state. No email addresses. */
  @Get(':id/participants')
  async participants(
    @Param('id', ParseIntPipe) id: number,
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sessions.trainerParticipants(scope, id, user.userId);
  }

  /** Mark or correct attendance for his own session. */
  @Put(':id/attendance')
  async saveAttendance(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveAttendanceDto,
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sessions.trainerSaveAttendance(scope, id, user.userId, dto);
  }
}
