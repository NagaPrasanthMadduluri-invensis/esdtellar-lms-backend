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
  Query,
} from '@nestjs/common';

import {
  CurrentScope,
  CurrentUser,
  Permissions,
  Roles,
} from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import {
  BulkSessionsDto,
  MoveToBatchDto,
  RosterAddDto,
  SessionBatchDto,
  RosterRemoveDto,
  SaveAttendanceDto,
  SessionDto,
} from './dto/session.dto';
import { SessionsService } from './sessions.service';

@Controller('admin/sessions')
@Roles('admin')
export class AdminSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @Query('archived') archived?: string,
  ) {
    // A SWAP, not an extra filter — archived and live are never listed
    // together, so the flag chooses which set rather than widening one.
    return this.sessions.list(scope, archived === 'true' || archived === '1');
  }

  /**
   * Bulk cancel / archive / restore / delete over a selection.
   *
   * Declared BEFORE `@Get(':sessionId')` and the other param routes, for the
   * reason the `trainers` route below already documents: Nest matches in
   * declaration order and `bulk` would otherwise arrive as a session id.
   *
   * 200, not 201 — nothing was created.
   */
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @Permissions('manage_sessions')
  async bulk(@Body() dto: BulkSessionsDto, @CurrentScope() scope: OrgScope) {
    return this.sessions.bulk(scope, dto.ids, dto.action);
  }

  /**
   * The trainers this organization can assign a session to — for the session
   * form's picker, which replaced a free-text trainer name (rbac.md §3.6.1).
   *
   * Declared BEFORE `@Get(':sessionId')`: Nest matches in declaration order,
   * so the other way round `trainers` is parsed as an id and ParseIntPipe 400s.
   */
  @Get('trainers')
  async trainers(@CurrentScope() scope: OrgScope) {
    return this.sessions.listTrainers(scope);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_sessions')
  async create(
    @Body() dto: SessionDto,
    @CurrentScope() scope: OrgScope,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.sessions.create(scope, dto, admin);
  }

  @Get(':sessionId')
  async get(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.get(scope, sessionId);
  }

  @Put(':sessionId')
  @Permissions('manage_sessions')
  async update(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: SessionDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.update(scope, sessionId, dto);
  }

  @Delete(':sessionId')
  @Permissions('manage_sessions')
  async remove(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.remove(scope, sessionId);
  }

  @Get(':sessionId/roster')
  async roster(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.roster(scope, sessionId);
  }

  /**
   * Manual completion — the only thing that credits the training, its learning
   * hours and the learner's completion metrics. Separate from the edit route so
   * the action is explicit at the call site rather than a status field an admin
   * could change while editing something else.
   */
  @Post(':sessionId/complete')
  @HttpCode(HttpStatus.OK)
  @Permissions('complete_session')
  async complete(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.complete(scope, sessionId);
  }

  @Post(':sessionId/roster')
  @HttpCode(HttpStatus.OK)
  @Permissions('manage_session_roster')
  async addToRoster(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: RosterAddDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.addToRoster(scope, sessionId, admin.userId, dto);
  }

  /* ── Batches ───────────────────────────────────────────────────────── */

  @Post(':sessionId/batches')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_sessions')
  async createBatch(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: SessionBatchDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.createBatch(scope, sessionId, dto);
  }

  @Put('batches/:batchId')
  @Permissions('manage_sessions')
  async updateBatch(
    @Param('batchId', ParseIntPipe) batchId: number,
    @Body() dto: SessionBatchDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.updateBatch(scope, batchId, dto);
  }

  @Delete('batches/:batchId')
  @Permissions('manage_sessions')
  async removeBatch(
    @Param('batchId', ParseIntPipe) batchId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.removeBatch(scope, batchId);
  }

  /** Move a rostered learner between sittings. Roster change, so it needs
   *  `manage_session_roster` rather than `manage_sessions` (rbac.md §3.6.1). */
  @Put(':sessionId/roster/batch')
  @Permissions('manage_session_roster')
  async moveToBatch(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: MoveToBatchDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.setRosterBatch(scope, sessionId, dto);
  }

  /* ── Waitlist ──────────────────────────────────────────────────────── */

  @Get(':sessionId/waitlist')
  async waitlist(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.waitlist(scope, sessionId);
  }

  /** Promote off the queue onto the roster — which is what creates their
   *  course assignment, so it is a roster write. */
  @Post(':sessionId/waitlist/:userId/promote')
  @HttpCode(HttpStatus.OK)
  @Permissions('manage_session_roster')
  async promote(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.promoteFromWaitlist(scope, sessionId, userId, admin.userId);
  }

  @Delete(':sessionId/waitlist/:userId')
  @Permissions('manage_session_roster')
  async dropFromWaitlist(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.removeFromWaitlist(scope, sessionId, userId);
  }

  @Delete(':sessionId/roster')
  @Permissions('manage_session_roster')
  async removeFromRoster(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: RosterRemoveDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.removeFromRoster(scope, sessionId, dto.user_id);
  }

  @Get(':sessionId/attendance')
  async attendance(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.attendance(scope, sessionId);
  }

  @Put(':sessionId/attendance')
  @Permissions('mark_attendance')
  async saveAttendance(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: SaveAttendanceDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.saveAttendance(scope, sessionId, admin.userId, dto);
  }
}

/**
 * The learner calendar. Note this is NOT restricted to `learner` — the legacy
 * route used a bare auth check, so an admin previewing the calendar still
 * works. It only ever returns the caller's own roster rows.
 */
@Controller('learner/sessions')
export class LearnerSessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.listForLearner(scope, user.userId);
  }
}
