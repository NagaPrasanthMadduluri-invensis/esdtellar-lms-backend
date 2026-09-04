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
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import {
  AssignScormDto,
  SaveTrackingDto,
  TrackDatamodelDto,
  UnassignScormDto,
} from './dto/scorm.dto';
import type { OrgScope } from '@/database/org-scope';
import { ListDatamodelQueryDto } from './dto/scorm.dto';

import { ScormService } from './scorm.service';

@Controller('admin/scorm')
@Roles('admin')
export class AdminScormController {
  constructor(private readonly scorm: ScormService) {}

  @Get()
  async list(@CurrentScope() scope: OrgScope) {
    return this.scorm.listPackages(scope);
  }

  /**
   * Declared before `:packageId` so the literal segment is not captured by the
   * parameter. Memory storage keeps the zip in a buffer for adm-zip; packages
   * are small enough that streaming to a temp file buys nothing.
   */
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('scorm_package'))
  async upload(
    @CurrentScope() scope: OrgScope,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { title?: string; course_id?: string },
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.scorm.upload(scope, file, admin.userId, body);
  }

  @Get(':packageId')
  async detail(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
  ) {
    return this.scorm.packageDetail(scope, packageId);
  }

  /** Attempt history + per-question breakdown for one learner. */
  @Get(':packageId/attempts/:userId')
  async learnerAttempts(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.scorm.learnerAttempts(scope, packageId, userId);
  }

  /** One learner's full runtime timeline on a package, for the admin view. */
  @Get(':packageId/datamodel/:userId')
  async learnerDatamodel(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @Param('userId', ParseIntPipe) userId: number,
    @Query() query: ListDatamodelQueryDto,
  ) {
    return this.scorm.datamodelForAdmin(
      scope,
      packageId,
      userId,
      query.limit,
      query.offset,
    );
  }

  @Delete(':packageId')
  async remove(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
  ) {
    return this.scorm.deletePackage(scope, packageId);
  }

  @Post(':packageId/assign')
  @HttpCode(HttpStatus.OK)
  async assign(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @Body() dto: AssignScormDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.scorm.assign(scope, packageId, admin.userId, dto);
  }

  @Delete(':packageId/assign')
  async unassign(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @Body() dto: UnassignScormDto,
  ) {
    return this.scorm.unassign(scope, packageId, dto.user_id);
  }
}

/**
 * Not role-restricted: the legacy routes used a bare auth check so an admin can
 * preview a package. Every query is still scoped to the caller's own access.
 */
@Controller('learner/scorm')
export class LearnerScormController {
  constructor(private readonly scorm: ScormService) {}

  @Get()
  async list(
    @CurrentScope() scope: OrgScope,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.listForLearner(scope, user.userId);
  }

  @Get(':packageId')
  async detail(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.packageForLearner(scope, user.userId, packageId);
  }

  @Get(':packageId/tracking')
  async tracking(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.tracking(scope, user.userId, packageId);
  }

  @Post(':packageId/tracking')
  @HttpCode(HttpStatus.OK)
  async saveTracking(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @Body() dto: SaveTrackingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.saveTracking(scope, user.userId, packageId, dto);
  }
  /**
   * Granular runtime telemetry — every `SetValue` the package made since the
   * last flush.
   *
   * Mounted here, on the learner controller, rather than at a top-level
   * `/api/v1/scorm/track`. Three reasons, all repo conventions rather than
   * taste: there is no `v1` segment anywhere in this API (the global prefix is
   * `api`, set once in `main.ts`); access is enforced by one class-level
   * decorator per audience (§2.2), and a shared top-level route would have to
   * branch on role inside the handler; and `packageId` in the path is what
   * lets `hasAccess` scope the write without trusting a body field.
   *
   * Coexists with `POST :packageId/tracking` — it does not replace it. That
   * endpoint upserts the resume record the player reloads on next launch; this
   * one appends the timeline. Losing a delta batch costs analytics, losing the
   * resume record costs the learner their place, so they stay separate writes.
   */
  @Post(':packageId/datamodel')
  @HttpCode(HttpStatus.OK)
  async trackDatamodel(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @Body() dto: TrackDatamodelDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.trackDatamodel(scope, user.userId, packageId, dto);
  }

  /** The learner's own timeline. Paginated — this table is unbounded (§7.6). */
  @Get(':packageId/datamodel')
  async datamodel(
    @CurrentScope() scope: OrgScope,
    @Param('packageId', ParseIntPipe) packageId: number,
    @Query() query: ListDatamodelQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.datamodelForLearner(
      scope,
      user.userId,
      packageId,
      query.limit,
      query.offset,
    );
  }
}
