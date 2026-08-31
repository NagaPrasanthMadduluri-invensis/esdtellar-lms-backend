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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { AssignScormDto, SaveTrackingDto, UnassignScormDto } from './dto/scorm.dto';
import type { OrgScope } from '@/database/org-scope';

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
}
