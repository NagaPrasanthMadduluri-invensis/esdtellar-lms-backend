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
import {
  EXTENSION_FOR_DOCUMENT_TYPE,
  RESOURCE_TYPE_FOR_MIME,
  type ConfirmVideoDto,
  type PresignDocumentDto,
  type PresignVideoDto,
  type VideoProgressDto,
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

  /* ─────────────────────────────────────────────
     Admin — documents

     Documents are uploaded the same way video is: the browser PUTs straight to
     R2 with a presigned URL, so the bytes never pass through this process.

     Unlike video there is no `confirm` endpoint. A document is attached by the
     lesson save itself (its key travels in the lesson payload) or by creating a
     resource row — both of which call `verifyUploadedDocument` first, so a key
     can only ever be stored once the bytes genuinely exist. Splitting it into a
     second round trip would buy nothing: there is no duration to report back,
     which is the only reason video needs one.
  ───────────────────────────────────────────── */

  /**
   * A URL for a document upload, minted before the lesson exists.
   *
   * The admin form uploads as soon as a file is chosen — the same reason
   * `presignStandaloneVideoUpload` exists — so the key lands under
   * `lessons/documents/incoming/` and is claimed by whichever lesson or
   * resource row is saved next.
   */
  async presignDocumentUpload(dto: PresignDocumentDto) {
    const maxBytes = this.config.get<number>('media.documentMaxBytes') ?? 0;
    if (maxBytes > 0 && dto.sizeBytes > maxBytes) {
      throw new UnprocessableEntityException(
        `Document is ${formatBytes(dto.sizeBytes)}, which exceeds the ` +
          `${formatBytes(maxBytes)} limit.`,
      );
    }

    const extension =
      EXTENSION_FOR_DOCUMENT_TYPE[dto.contentType] ??
      extname(dto.filename).replace('.', '').toLowerCase() ??
      'pdf';

    const key = `lessons/documents/incoming/${randomUUID()}.${extension}`;
    const uploadUrl = await this.storage.presignUpload(key, dto.contentType);

    return {
      uploadUrl,
      key,
      expiresIn: this.config.get<number>('media.uploadUrlTtlSeconds') ?? 3600,
    };
  }

  /**
   * Proves an uploaded document is really there before anything records its key.
   *
   * Without this a failed or abandoned upload would leave a lesson pointing at
   * nothing, and the learner would find out instead of the admin. The prefix
   * check is the same guard the video confirm makes: a key from outside the
   * document upload paths cannot be smuggled in to repoint a lesson at some
   * other object in the bucket.
   */
  async verifyUploadedDocument(key: string): Promise<{
    sizeBytes: number;
    contentType: string | null;
  }> {
    const allowed =
      key.startsWith('lessons/documents/incoming/') ||
      /^lessons\/\d+\/(document|resource)\//.test(key);
    if (!allowed) {
      throw new BadRequestException('Object key is not a lesson document.');
    }

    const stat = await this.storage.statObject(key);
    if (!stat) {
      throw new UnprocessableEntityException(
        'Upload not found in storage. The document may not have finished uploading.',
      );
    }

    const maxBytes = this.config.get<number>('media.documentMaxBytes') ?? 0;
    if (maxBytes > 0 && stat.size > maxBytes) {
      // A presigned PUT cannot cap its own body, so the real size is only
      // knowable here. Drop the object rather than keep one over the limit.
      await this.storage.deleteObject(key);
      throw new UnprocessableEntityException(
        `Uploaded document is ${formatBytes(stat.size)}, which exceeds the ` +
          `${formatBytes(maxBytes)} limit.`,
      );
    }

    return { sizeBytes: stat.size, contentType: stat.contentType };
  }

  /** A short-lived URL to read a stored document. */
  async documentUrl(key: string): Promise<string> {
    return this.storage.presignDownload(key);
  }

  /**
   * Best-effort removal of a stored object, for when a document is replaced or
   * a resource deleted. Never throws into the caller (§8.4) — an orphaned
   * object costs storage, a thrown error costs the admin their edit.
   */
  async discardObject(key: string | null | undefined): Promise<void> {
    if (!key) return;
    await this.storage.deleteObject(key);
  }

  /** The coarse kind a mime type maps to, for the icon and label. */
  resourceTypeForMime(mime: string | null | undefined): string {
    return RESOURCE_TYPE_FOR_MIME[(mime ?? '').toLowerCase()] ?? 'other';
  }

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
        // The document key belongs here too: it is a lesson-owned object, and
        // once the row is gone nothing records which key was its.
        [lesson.video_key, lesson.caption_key, lesson.document_key]
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
  /**
   * A link to one supporting resource.
   *
   * An uploaded resource is signed per request, like every other stored object
   * — the key never reaches the browser. A linked one is just its URL, but it
   * still goes through here so entitlement is checked the same way either way.
   */
  async learnerResourceUrl(resourceId: number, userId: number) {
    const resource = await this.repository.findResourceForLearner(
      resourceId,
      userId,
    );
    if (!resource) throw new NotFoundException('Resource not found');

    if (!resource.assigned && !resource.is_preview) {
      throw new ForbiddenException('You are not enrolled in this course.');
    }

    if (resource.source === 'link') {
      return { url: resource.url, expiresIn: 0, title: resource.title };
    }

    if (!resource.file_key) {
      throw new NotFoundException('Resource file is missing.');
    }

    const ttl = this.config.get<number>('media.videoUrlTtlSeconds') ?? 900;
    return {
      url: await this.storage.presignDownload(resource.file_key, ttl),
      expiresIn: ttl,
      title: resource.title,
      fileName: resource.file_name,
      mimeType: resource.mime_type,
    };
  }

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

    // A document lesson has no video, so the player never asks — but the same
    // endpoint is what hands back a link to the document, and it must be signed
    // per request for exactly the reason the video URL is.
    if (!lesson.video_key) {
      const documentUrl = lesson.document_key
        ? await this.storage.presignDownload(lesson.document_key)
        : null;

      return {
        lessonId: lesson.id,
        videoUrl: null,
        captionUrl: null,
        expiresIn: documentUrl
          ? (this.config.get<number>('media.videoUrlTtlSeconds') ?? 900)
          : 0,
        documentUrl,
        documentName: lesson.document_name,
        documentMime: lesson.document_mime,
        documentSizeBytes: lesson.document_size_bytes,
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
