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

import { CurrentScope, CurrentUser, Permissions, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';

import { AssignJourneyDto } from './dto/assign-journey.dto';
import {
  JourneyDto,
  ListJourneyLearnersQueryDto,
  BulkJourneysDto,
  ListJourneysQueryDto,
  SetJourneyCoursesDto,
} from './dto/journey.dto';
import { JourneysService } from './journeys.service';

/**
 * Reads stay open to the whole admin audience (spec §5.2.1 — content reads
 * are not withheld; an `assign_learning` role has to be able to list
 * journeys to assign one). Every WRITE carries `manage_journeys`; the two
 * assignment routes carry `assign_learning` instead, since assigning is not
 * editing the journey's content.
 */
@Controller('admin/journeys')
@Roles('admin')
export class AdminJourneysController {
  constructor(private readonly journeys: JourneysService) {}

  @Get()
  async list(@Query() query: ListJourneysQueryDto, @CurrentScope() scope: OrgScope) {
    return this.journeys.listForAdmin(scope, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('manage_journeys')
  async create(@Body() dto: JourneyDto, @CurrentScope() scope: OrgScope) {
    return this.journeys.create(scope, dto);
  }

  /**
   * Bulk activate / draft / archive / restore / delete.
   *
   * Declared BEFORE `@Get(':id')` and `@Put(':id')` below — Nest matches
   * routes in declaration order, and `bulk` would otherwise be swallowed by
   * the `:id` param route and arrive as a journey id of "bulk".
   *
   * 200, not 201: nothing was created.
   */
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  @Permissions('manage_journeys')
  async bulk(@Body() dto: BulkJourneysDto, @CurrentScope() scope: OrgScope) {
    return this.journeys.bulk(scope, dto);
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: OrgScope) {
    return this.journeys.get(scope, id);
  }

  @Put(':id')
  @Permissions('manage_journeys')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: JourneyDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.journeys.update(scope, id, dto);
  }

  @Delete(':id')
  @Permissions('manage_journeys')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentScope() scope: OrgScope) {
    return this.journeys.remove(scope, id);
  }

  @Put(':id/courses')
  @Permissions('manage_journeys')
  async setCourses(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetJourneyCoursesDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.journeys.setCourses(scope, id, dto);
  }

  @Get(':id/learners')
  async listLearners(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ListJourneyLearnersQueryDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.journeys.listLearners(scope, id, query);
  }

  @Post(':id/assign')
  @Permissions('assign_learning')
  async assign(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AssignJourneyDto,
    @CurrentUser() admin: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.journeys.assign(scope, id, dto, admin.userId);
  }

  @Delete(':id/assign/:userId')
  @Permissions('assign_learning')
  async unassign(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.journeys.unassign(scope, id, userId);
  }
}
