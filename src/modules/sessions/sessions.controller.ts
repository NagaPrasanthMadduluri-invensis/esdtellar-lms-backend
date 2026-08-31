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

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import {
  RosterAddDto,
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
  async list(@CurrentScope() scope: OrgScope) {
    return this.sessions.list(scope);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: SessionDto, @CurrentScope() scope: OrgScope) {
    return this.sessions.create(scope, dto);
  }

  @Get(':sessionId')
  async get(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.get(scope, sessionId);
  }

  @Put(':sessionId')
  async update(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: SessionDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.update(scope, sessionId, dto);
  }

  @Delete(':sessionId')
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
  async complete(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.complete(scope, sessionId);
  }

  @Post(':sessionId/roster')
  @HttpCode(HttpStatus.OK)
  async addToRoster(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: RosterAddDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.sessions.addToRoster(scope, sessionId, admin.userId, dto);
  }

  @Delete(':sessionId/roster')
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
