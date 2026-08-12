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

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

import { AssignScormDto, SaveTrackingDto, UnassignScormDto } from './dto/scorm.dto';
import { ScormService } from './scorm.service';

@Controller('admin/scorm')
@Roles('admin')
export class AdminScormController {
  constructor(private readonly scorm: ScormService) {}

  @Get()
  async list() {
    return this.scorm.listPackages();
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
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { title?: string; course_id?: string },
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.scorm.upload(file, admin.userId, body);
  }

  @Get(':packageId')
  async detail(@Param('packageId', ParseIntPipe) packageId: number) {
    return this.scorm.packageDetail(packageId);
  }

  @Delete(':packageId')
  async remove(@Param('packageId', ParseIntPipe) packageId: number) {
    return this.scorm.deletePackage(packageId);
  }

  @Post(':packageId/assign')
  @HttpCode(HttpStatus.OK)
  async assign(
    @Param('packageId', ParseIntPipe) packageId: number,
    @Body() dto: AssignScormDto,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    return this.scorm.assign(packageId, admin.userId, dto);
  }

  @Delete(':packageId/assign')
  async unassign(
    @Param('packageId', ParseIntPipe) packageId: number,
    @Body() dto: UnassignScormDto,
  ) {
    return this.scorm.unassign(packageId, dto.user_id);
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
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.scorm.listForLearner(user.userId);
  }

  @Get(':packageId')
  async detail(
    @Param('packageId', ParseIntPipe) packageId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.packageForLearner(user.userId, packageId);
  }

  @Get(':packageId/tracking')
  async tracking(
    @Param('packageId', ParseIntPipe) packageId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.tracking(user.userId, packageId);
  }

  @Post(':packageId/tracking')
  @HttpCode(HttpStatus.OK)
  async saveTracking(
    @Param('packageId', ParseIntPipe) packageId: number,
    @Body() dto: SaveTrackingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.scorm.saveTracking(user.userId, packageId, dto);
  }
}
