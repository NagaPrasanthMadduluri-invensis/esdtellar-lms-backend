import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import { CurrentScope, CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import { PublicIdService } from '@/database/public-id.service';

import { VideoProgressDto } from './dto/media.dto';
import { MediaService } from './media.service';

/**
 * Playback URLs for the learner's video player.
 *
 * The URL is minted per request and expires, so it is never stored on the
 * lesson row and never cached in a response the browser could keep. Whether the
 * caller is entitled to this lesson is decided in the service, from the
 * verified JWT — never from anything the client sends.
 */
@Controller('learner/lessons')
@Roles('learner')
export class LearnerMediaController {
  constructor(
    private readonly media: MediaService,
    // :lessonId is now the lesson's public UUID (0046); resolve it to the
    // integer id, still accepting a bare integer during the transition.
    private readonly publicId: PublicIdService,
  ) {}

  @Get(':lessonId/media')
  async media_(
    @Param('lessonId') lessonIdParam: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    const lessonId = await this.publicId.resolveIdOrThrow('lessons', lessonIdParam);
    return this.media.learnerLessonMedia(scope, lessonId, user.userId);
  }

  /**
   * The document itself, streamed through this process.
   *
   * ## Why this route exists at all
   *
   * It replaced a presigned R2 URL. A presigned URL carries its own
   * authorisation, so it works for ANYONE who has the string — signed out, in
   * another tenant, from another country — for the whole of its TTL. Reading
   * one out of the Network tab and pasting it into a chat is a complete
   * bypass of every check in this file, and nothing server-side would ever
   * know it had happened.
   *
   * This URL is same-origin and carries no authorisation of its own. The
   * cookie does, and the cookie is HttpOnly and belongs to one person. Replay
   * it as somebody else and the guard returns 401; replay it as a learner in
   * another organization and the scope check returns 404.
   *
   * ## What it deliberately does NOT claim
   *
   * It does not stop the entitled learner from saving the file. Nothing can:
   * their browser has the bytes in order to show them, and a browser that
   * holds bytes can write them to disk. What removes that last path is not
   * doing it here — it is `documentPages`, which serves rasterised page
   * images so the source file never reaches a browser in the first place.
   * This route is what the viewer's images are fetched through.
   *
   * `inline`, so a PDF opens in the viewer rather than hitting the download
   * tray, and `no-store`, so it does not sit in the browser cache after the
   * learner's access is withdrawn.
   */
  @Get(':lessonId/document')
  async document(
    @Param('lessonId') lessonIdParam: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
    @Res() res: Response,
  ) {
    const lessonId = await this.publicId.resolveIdOrThrow('lessons', lessonIdParam);
    const doc = await this.media.openLearnerDocument(scope, lessonId, user.userId);
    if (!doc) throw new NotFoundException('This lesson has no document.');

    res.setHeader('Content-Type', doc.contentType);
    // The filename is quoted and stripped of quotes and newlines: it comes
    // from a column an admin filled in, and a raw value here is header
    // injection into every response.
    const safeName = doc.filename.replace(/["\r\n\\]/g, '').slice(0, 200);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    if (doc.contentLength !== null) {
      res.setHeader('Content-Length', String(doc.contentLength));
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    doc.stream.pipe(res);
  }

  /**
   * Reports how far the learner has watched. Called periodically by the player
   * and once more when it unmounts, so time is not lost if the tab is closed.
   */
  @Post(':lessonId/video-progress')
  @HttpCode(HttpStatus.OK)
  async saveProgress(
    @Param('lessonId') lessonIdParam: string,
    @Body() dto: VideoProgressDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    const lessonId = await this.publicId.resolveIdOrThrow('lessons', lessonIdParam);
    return this.media.saveVideoProgress(scope, lessonId, user.userId, dto);
  }
}

/**
 * Supporting resources, on their own path so a resource id is never read as a
 * lesson id.
 */
@Controller('learner/resources')
@Roles('learner')
export class LearnerResourcesController {
  constructor(private readonly media: MediaService) {}

  /**
   * A signed URL for an uploaded resource, or the external URL for a linked
   * one. Minted per click rather than handed out with the lesson, so an
   * unopened resource costs nothing and no link outlives its TTL inside a
   * response the browser might keep.
   */
  @Get(':resourceId/url')
  async url(
    @Param('resourceId', ParseIntPipe) resourceId: number,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentScope() scope: OrgScope,
  ) {
    return this.media.learnerResourceUrl(scope, resourceId, user.userId);
  }
}
