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

import { CurrentScope, Permissions, Roles } from '@/common/decorators';
import type { OrgScope } from '@/database/org-scope';

import {
  COURSE_THUMBNAIL_MAX_BYTES,
  ConfirmVideoDto,
  DiscardThumbnailDto,
  PresignDocumentDto,
  PresignVideoDto,
} from './dto/media.dto';
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
  @Permissions('upload_content')
  async presignVideo(@Body() dto: PresignVideoDto) {
    return this.media.presignStandaloneVideoUpload(dto);
  }

  /**
   * The same, for a document — a lesson's primary file or a supporting
   * resource. One endpoint for both: the key is claimed by whichever row is
   * saved next, so the upload does not need to know which it will become.
   */
  @Post('document/presign')
  @HttpCode(HttpStatus.OK)
  @Permissions('upload_content')
  async presignDocument(@Body() dto: PresignDocumentDto) {
    return this.media.presignDocumentUpload(dto);
  }

  /**
   * A cover picture, posted as multipart rather than presigned.
   *
   * One endpoint for courses AND sessions, because a session's picture is
   * stored on its companion training course (§10.7) — the destination really
   * is `courses.thumbnail_url` in both cases.
   *
   * That is also why it is guarded by `upload_content` rather than
   * `manage_courses`, which the first version used on the argument that the
   * image had exactly one destination. It has two audiences now, the guard
   * has no "any of" form (`PermissionsGuard`), and requiring `manage_courses`
   * to put a picture on a session would be surprising. `upload_content` is the
   * permission that already guards every other file upload here — video,
   * documents, SCORM — and an upload on its own changes nothing: the row that
   * references the key is saved behind `manage_courses` or `manage_sessions`
   * respectively.
   *
   * The multer limit is what actually enforces the size cap: it refuses an
   * oversized body before it is buffered, with a bare 413. The admin does not
   * normally see that — the browser checks the same limit before sending, and
   * says which file and what the limit is. MediaService checks it a third
   * time, so the cap survives this interceptor option being changed.
   */
  @Post('course-thumbnail')
  @HttpCode(HttpStatus.OK)
  @Permissions('upload_content')
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: COURSE_THUMBNAIL_MAX_BYTES } }),
  )
  async uploadCourseThumbnail(@UploadedFile() file: Express.Multer.File) {
    return this.media.uploadCourseThumbnail(file);
  }

  /**
   * Drops a thumbnail whose course or session then failed to save.
   *
   * The client's own rollback, the same shape as the lesson editor's SCORM
   * rollback: the browser knows at once that the save failed, and it is the
   * only party that knows the upload is now pointing at nothing.
   */
  @Delete('course-thumbnail')
  @Permissions('upload_content')
  async deleteCourseThumbnail(@Body() dto: DiscardThumbnailDto) {
    await this.media.discardCourseThumbnail(dto.url);
    return { ok: true };
  }
}

@Controller('admin/lessons')
@Roles('admin')
export class AdminMediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':lessonId/media')
  async media_(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.media.adminLessonMedia(scope, lessonId);
  }

  @Post(':lessonId/video/presign')
  @HttpCode(HttpStatus.OK)
  @Permissions('upload_content')
  async presignVideo(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: PresignVideoDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.media.presignVideoUpload(scope, lessonId, dto);
  }

  @Post(':lessonId/video/confirm')
  @HttpCode(HttpStatus.OK)
  @Permissions('upload_content')
  async confirmVideo(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: ConfirmVideoDto,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.media.confirmVideoUpload(scope, lessonId, dto);
  }

  @Delete(':lessonId/video')
  @Permissions('upload_content')
  async removeVideo(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.media.removeVideo(scope, lessonId);
  }

  @Post(':lessonId/captions')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('captions'))
  @Permissions('upload_content')
  async uploadCaptions(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @UploadedFile() file: Express.Multer.File,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.media.uploadCaptions(scope, lessonId, file);
  }

  @Delete(':lessonId/captions')
  @Permissions('upload_content')
  async removeCaptions(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.media.removeCaptions(scope, lessonId);
  }
}
