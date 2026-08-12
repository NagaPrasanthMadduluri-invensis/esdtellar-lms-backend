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

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

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
  async list() {
    return this.sessions.list();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: SessionDto) {
    return this.sessions.create(dto);
  }

  @Get(':sessionId')
  async get(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.sessions.get(sessionId);
  }

  @Put(':sessionId')
  async update(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: SessionDto,
  ) {
    return this.sessions.update(sessionId, dto);
  }

  @Delete(':sessionId')
  async remove(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.sessions.remove(sessionId);
  }

  @Get(':sessionId/roster')
  async roster(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.sessions.roster(sessionId);
  }

  @Post(':sessionId/roster')
  @HttpCode(HttpStatus.OK)
  async addToRoster(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: RosterAddDto,
  ) {
    return this.sessions.addToRoster(sessionId, dto);
  }

  @Delete(':sessionId/roster')
  async removeFromRoster(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: RosterRemoveDto,
  ) {
    return this.sessions.removeFromRoster(sessionId, dto.user_id);
  }

  @Get(':sessionId/attendance')
  async attendance(@Param('sessionId', ParseIntPipe) sessionId: number) {
    return this.sessions.attendance(sessionId);
  }

  @Put(':sessionId/attendance')
  async saveAttendance(
    @Param('sessionId', ParseIntPipe) sessionId: number,
    @Body() dto: SaveAttendanceDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.sessions.saveAttendance(sessionId, admin.userId, dto);
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
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.sessions.listForLearner(user.userId);
  }
}
