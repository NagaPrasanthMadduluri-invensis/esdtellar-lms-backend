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

import { Roles } from '@/common/decorators';

import { ConfirmVideoDto, PresignVideoDto } from './dto/media.dto';
import { MediaService } from './media.service';

/**
 * Lesson media administration.
 *
 * The video upload is deliberately two calls — `presign` then `confirm` — with
 * the bytes going straight from the admin's browser to R2 in between. Nothing
 * here ever holds a video in memory. Captions are the exception: they are tiny
 * and need converting to WebVTT, so they are posted here as multipart.
 */
/**
 * Upload endpoints that do not name a lesson.
 *
 * Its own base path rather than a literal segment under `admin/lessons`, so it
 * can never be captured by the `:lessonId` parameter route.
 */
@Controller('admin/media')
@Roles('admin')
export class AdminMediaUploadController {
  constructor(private readonly media: MediaService) {}

  /** Presign before the lesson exists, so the form can upload on file-select. */
  @Post('video/presign')
  @HttpCode(HttpStatus.OK)
  async presignVideo(@Body() dto: PresignVideoDto) {
    return this.media.presignStandaloneVideoUpload(dto);
  }
}

@Controller('admin/lessons')
@Roles('admin')
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':lessonId/media')
  async media_(@Param('lessonId', ParseIntPipe) lessonId: number) {
    return this.media.adminLessonMedia(lessonId);
  }

  @Post(':lessonId/video/presign')
  @HttpCode(HttpStatus.OK)
  async presignVideo(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: PresignVideoDto,
  ) {
    return this.media.presignVideoUpload(lessonId, dto);
  }

  @Post(':lessonId/video/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmVideo(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: ConfirmVideoDto,
  ) {
    return this.media.confirmVideoUpload(lessonId, dto);
  }

  @Delete(':lessonId/video')
  async removeVideo(@Param('lessonId', ParseIntPipe) lessonId: number) {
    return this.media.removeVideo(lessonId);
  }

  @Post(':lessonId/captions')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('captions'))
  async uploadCaptions(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.media.uploadCaptions(lessonId, file);
  }

  @Delete(':lessonId/captions')
  async removeCaptions(@Param('lessonId', ParseIntPipe) lessonId: number) {
    return this.media.removeCaptions(lessonId);
  }
}
