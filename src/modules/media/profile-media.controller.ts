import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { AVATAR_MAX_BYTES, DiscardAvatarDto } from './dto/media.dto';
import { MediaService } from './media.service';

/**
 * Profile-picture upload, reachable by ANY authenticated role.
 *
 * Deliberately NOT under `admin/media` and carrying no `@Roles()`: every
 * portal's top bar opens the "My profile" dialog, so a learner and a trainer
 * upload their own avatar here just as an admin does. The global AuthGuard still
 * protects it — authenticated, not public.
 *
 * Two calls, the same shape as the course-thumbnail rollback: upload returns a
 * stored path, and the profile PATCH (`/auth/profile`) is what records it on the
 * user. An upload on its own changes nothing, so no finer permission is needed;
 * `AuthService.updateProfile` validates the path before writing it.
 */
@Controller('media')
export class ProfileMediaController {
  constructor(private readonly media: MediaService) {}

  @Post('avatar')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: AVATAR_MAX_BYTES } }),
  )
  async uploadAvatar(@UploadedFile() file: Express.Multer.File) {
    return this.media.uploadAvatar(file);
  }

  /** Drops an avatar whose profile edit was then cancelled. Best-effort. */
  @Delete('avatar')
  async deleteAvatar(@Body() dto: DiscardAvatarDto) {
    await this.media.discardAvatar(dto.url);
    return { ok: true };
  }
}
