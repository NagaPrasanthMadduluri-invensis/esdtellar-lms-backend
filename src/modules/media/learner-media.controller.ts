import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { CurrentUser, Roles } from '@/common/decorators';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';

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
  constructor(private readonly media: MediaService) {}

  @Get(':lessonId/media')
  async media_(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.media.learnerLessonMedia(lessonId, user.userId);
  }

  /**
   * Reports how far the learner has watched. Called periodically by the player
   * and once more when it unmounts, so time is not lost if the tab is closed.
   */
  @Post(':lessonId/video-progress')
  @HttpCode(HttpStatus.OK)
  async saveProgress(
    @Param('lessonId', ParseIntPipe) lessonId: number,
    @Body() dto: VideoProgressDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.media.saveVideoProgress(lessonId, user.userId, dto);
  }
}
