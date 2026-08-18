import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { toWebVtt } from './captions.util';
import { MediaRepository } from './media.repository';
import { R2StorageService } from './storage/r2-storage.service';
import type {
  ConfirmVideoDto,
  PresignVideoDto,
  VideoProgressDto,
} from './dto/media.dto';

const EXTENSION_FOR_TYPE: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly repository: MediaRepository,
    private readonly storage: R2StorageService,
    private readonly config: ConfigService,
  ) {}

  /* ─────────────────────────────────────────────
     Admin — video
  ───────────────────────────────────────────── */

  /**
   * Step 1 of the upload: hand back a URL the browser PUTs the file to.
   *
   * The bytes never touch this process, so the only work here is authorising
   * the lesson, capping the size, and minting a key.
   */
  async presignVideoUpload(lessonId: number, dto: PresignVideoDto) {
    const lesson = await this.repository.findLesson(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    const maxBytes = this.config.get<number>('media.videoMaxBytes') ?? 0;
    if (maxBytes > 0 && dto.sizeBytes > maxBytes) {
      throw new UnprocessableEntityException(
        `Video is ${formatBytes(dto.sizeBytes)}, which exceeds the ${formatBytes(
          maxBytes,
        )} limit.`,
      );
    }

    const extension =
      EXTENSION_FOR_TYPE[dto.contentType] ??
      extname(dto.filename).replace('.', '').toLowerCase() ??
      'mp4';

    const key = this.storage.buildKey(lessonId, 'video', extension);
    const uploadUrl = await this.storage.presignUpload(key, dto.contentType);

    return {
      uploadUrl,
      key,
      expiresIn: this.config.get<number>('media.uploadUrlTtlSeconds') ?? 3600,
    };
  }

  /**
   * Presign for a lesson that does not exist yet.
   *
   * The admin form uploads as soon as a file is chosen, so "Add lesson" can be
   * gated on the upload finishing. At that moment there is no lesson id to
   * namespace the key with, so it lands under `lessons/incoming/` and is
   * attached by `confirmVideoUpload` once the row exists. The key is stored
   * as-is — nothing later depends on the prefix, so there is no need to copy
   * the object into a lesson-scoped path afterwards.
   */
  async presignStandaloneVideoUpload(dto: PresignVideoDto) {
    const maxBytes = this.config.get<number>('media.videoMaxBytes') ?? 0;
    if (maxBytes > 0 && dto.sizeBytes > maxBytes) {
      throw new UnprocessableEntityException(
        `Video is ${formatBytes(dto.sizeBytes)}, which exceeds the ${formatBytes(
          maxBytes,
        )} limit.`,
      );
    }

    const extension =
      EXTENSION_FOR_TYPE[dto.contentType] ??
      extname(dto.filename).replace('.', '').toLowerCase() ??
      'mp4';

    const key = `lessons/incoming/${randomUUID()}.${extension}`;
    const uploadUrl = await this.storage.presignUpload(key, dto.contentType);

    return {
      uploadUrl,
      key,
      expiresIn: this.config.get<number>('media.uploadUrlTtlSeconds') ?? 3600,
    };
  }

  /**
   * Step 2: the browser reports the upload finished, and the key is recorded.
   *
   * The object is probed with HeadObject first, so a key can only be attached
   * once the bytes genuinely exist in R2 — a failed or abandoned upload leaves
   * the lesson untouched rather than pointing at nothing. The key is also
   * required to sit under this lesson's prefix, so a confirm call cannot
   * repoint a lesson at some other lesson's object.
   */
  async confirmVideoUpload(lessonId: number, dto: ConfirmVideoDto) {
    const lesson = await this.repository.findLesson(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    // Either a key minted for this lesson, or one from the pre-creation upload
    // path. Anything else is refused so a confirm cannot repoint a lesson at
    // some other lesson's stored object.
    const ownPrefix = `lessons/${lessonId}/video/`;
    const incomingPrefix = 'lessons/incoming/';
    if (
      !dto.key.startsWith(ownPrefix) &&
      !dto.key.startsWith(incomingPrefix)
    ) {
      throw new BadRequestException(
        'Object key does not belong to this lesson.',
      );
    }

    const stat = await this.storage.statObject(dto.key);
    if (!stat) {
      throw new UnprocessableEntityException(
        'Upload not found in storage. The video may not have finished uploading.',
      );
    }

    const maxBytes = this.config.get<number>('media.videoMaxBytes') ?? 0;
    if (maxBytes > 0 && stat.size > maxBytes) {
      // Enforced here because a presigned PUT cannot cap its own body size.
      await this.storage.deleteObject(dto.key);
      throw new UnprocessableEntityException(
        `Uploaded video is ${formatBytes(stat.size)}, which exceeds the ` +
          `${formatBytes(maxBytes)} limit.`,
      );
    }

    const previousKey = lesson.video_key;
    await this.repository.setVideoKey(lessonId, dto.key);

    // The browser reads this off the file's own metadata, so the stored length
    // is the video's real one rather than a number someone typed. Optional:
    // an older client that does not send it simply leaves the column alone.
    if (dto.durationSeconds !== undefined && dto.durationSeconds !== null) {
      await this.repository.setVideoDuration(
        lessonId,
        Math.round(dto.durationSeconds),
      );
    }

    // Replacing a video orphans the old object; clearing it is best-effort and
    // must not fail the request (§8.4).
    if (previousKey && previousKey !== dto.key) {
      await this.storage.deleteObject(previousKey);
    }

    return { ok: true, key: dto.key, sizeBytes: stat.size };
  }

  async removeVideo(lessonId: number) {
    const lesson = await this.repository.findLesson(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (!lesson.video_key) return { ok: true };

    await this.repository.setVideoKey(lessonId, null);
    await this.storage.deleteObject(lesson.video_key);
    return { ok: true };
  }

  /* ─────────────────────────────────────────────
     Admin — captions
  ───────────────────────────────────────────── */

  /**
   * Captions go through the API rather than direct-to-R2, unlike the video.
   * They are kilobytes, and routing them here is what lets an `.srt` be
   * converted to the WebVTT that `<track>` requires before it is ever stored.
   */
  async uploadCaptions(lessonId: number, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('No caption file was uploaded.');

    const lesson = await this.repository.findLesson(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    const maxBytes = this.config.get<number>('media.captionMaxBytes') ?? 0;
    if (maxBytes > 0 && file.size > maxBytes) {
      throw new UnprocessableEntityException(
        `Caption file exceeds the ${formatBytes(maxBytes)} limit.`,
      );
    }

    let vtt: string;
    try {
      vtt = toWebVtt(file.buffer.toString('utf8'));
    } catch (error) {
      throw new UnprocessableEntityException(
        error instanceof Error ? error.message : 'Invalid caption file.',
      );
    }

    const key = this.storage.buildKey(lessonId, 'captions', 'vtt');
    await this.storage.putObject(key, Buffer.from(vtt, 'utf8'), 'text/vtt');

    const previousKey = lesson.caption_key;
    await this.repository.setCaptionKey(lessonId, key);
    if (previousKey && previousKey !== key) {
      await this.storage.deleteObject(previousKey);
    }

    return { ok: true, key };
  }

  async removeCaptions(lessonId: number) {
    const lesson = await this.repository.findLesson(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (!lesson.caption_key) return { ok: true };

    await this.repository.setCaptionKey(lessonId, null);
    await this.storage.deleteObject(lesson.caption_key);
    return { ok: true };
  }

  /**
   * Deletes whatever a lesson has in R2, without touching the lesson row.
   *
   * Called by the courses module just before a lesson is deleted. Entirely
   * best-effort and never throws: failing to reach storage must not block the
   * admin from deleting a lesson (§8.4). A missing lesson is not an error here
   * either — the caller may be cleaning up something already gone.
   */
  async releaseLessonMedia(lessonId: number): Promise<void> {
    try {
      const lesson = await this.repository.findLesson(lessonId);
      if (!lesson) return;

      await Promise.all(
        [lesson.video_key, lesson.caption_key]
          .filter((key): key is string => Boolean(key))
          .map((key) => this.storage.deleteObject(key)),
      );
    } catch (error) {
      this.logger.warn(
        `Could not release media for lesson ${lessonId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Admin-side view of what a lesson currently has attached. */
  async adminLessonMedia(lessonId: number) {
    const lesson = await this.repository.findLesson(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    const ttl = this.config.get<number>('media.videoUrlTtlSeconds') ?? 900;
    return {
      lessonId: lesson.id,
      hasVideo: Boolean(lesson.video_key),
      hasCaptions: Boolean(lesson.caption_key),
      // Admins get a preview URL too, so they can confirm the upload plays.
      videoUrl: lesson.video_key
        ? await this.storage.presignDownload(lesson.video_key, ttl)
        : null,
      captionUrl: lesson.caption_key
        ? await this.storage.presignDownload(lesson.caption_key, ttl)
        : null,
      expiresIn: ttl,
    };
  }

  /* ─────────────────────────────────────────────
     Learner — playback
  ───────────────────────────────────────────── */

  /**
   * Mints the playback URLs for one lesson.
   *
   * Entitlement is checked here, not in the query (§5.3): a lesson that exists
   * but is not assigned is a 403, and one that does not exist is a 404. Preview
   * lessons are watchable without an assignment, which is what `is_preview` is
   * for.
   *
   * `expiresIn` is returned so the player can refresh the URL before it lapses
   * instead of failing mid-video.
   */
  /**
   * Records how much of a video the learner has actually watched.
   *
   * Entitlement is re-checked on every write — this endpoint is the only way
   * learning hours can be increased from the client, so it must not trust a
   * lesson id alone. `watchedSeconds` is clamped to the video's real duration
   * where one is known, so a tampered payload cannot inflate a learner's hours
   * beyond the length of the material.
   */
  async saveVideoProgress(
    lessonId: number,
    userId: number,
    dto: VideoProgressDto,
  ) {
    const lesson = await this.repository.findLessonForLearner(lessonId, userId);
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (!lesson.assigned && !lesson.is_preview) {
      throw new ForbiddenException('You are not enrolled in this course.');
    }

    const cap = lesson.video_duration_seconds;
    const watched =
      cap && cap > 0
        ? Math.min(dto.watchedSeconds, cap)
        : dto.watchedSeconds;

    await this.repository.upsertVideoProgress({
      userId,
      lessonId,
      watchedSeconds: Math.round(watched),
      positionSeconds: Math.round(dto.positionSeconds),
    });

    return { ok: true, watchedSeconds: Math.round(watched) };
  }

  async learnerLessonMedia(lessonId: number, userId: number) {
    const lesson = await this.repository.findLessonForLearner(lessonId, userId);
    if (!lesson) throw new NotFoundException('Lesson not found');

    if (!lesson.assigned && !lesson.is_preview) {
      throw new ForbiddenException('You are not enrolled in this course.');
    }

    if (!lesson.video_key) {
      return {
        lessonId: lesson.id,
        videoUrl: null,
        captionUrl: null,
        expiresIn: 0,
      };
    }

    const ttl = this.config.get<number>('media.videoUrlTtlSeconds') ?? 900;

    // Both URLs are signed in parallel — two independent signature
    // computations, no reason to await them in sequence.
    const [videoUrl, captionUrl, progress] = await Promise.all([
      this.storage.presignDownload(lesson.video_key, ttl),
      lesson.caption_key
        ? this.storage.presignDownload(lesson.caption_key, ttl)
        : Promise.resolve(null),
      this.repository.findVideoProgress(userId, lessonId),
    ]);

    return {
      lessonId: lesson.id,
      videoUrl,
      captionUrl,
      expiresIn: ttl,
      durationSeconds: lesson.video_duration_seconds,
      watchedSeconds: progress?.watched_seconds ?? 0,
      resumeAtSeconds: progress?.last_position_seconds ?? 0,
    };
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
