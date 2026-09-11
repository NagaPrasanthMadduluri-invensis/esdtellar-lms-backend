import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Formats the learner's `<video>` element can actually play. The list is
 * closed on purpose: a presigned upload URL is signed with the declared
 * content type, so whatever is allowed here is exactly what can be stored.
 */
export const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
] as const;

export class PresignVideoDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsIn(ALLOWED_VIDEO_TYPES as unknown as string[], {
    message: `contentType must be one of: ${ALLOWED_VIDEO_TYPES.join(', ')}`,
  })
  contentType!: string;

  /**
   * Declared up front so an oversized file is rejected before the admin spends
   * minutes uploading it. The real size is verified against R2 on confirm — a
   * presigned PUT cannot enforce a byte cap by itself.
   */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes!: number;
}

export class ConfirmVideoDto {
  @IsString()
  @MaxLength(512)
  key!: string;

  /** Real length read from the file's metadata in the browser. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  durationSeconds?: number;
}

export class VideoProgressDto {
  /**
   * Furthest point reached, in seconds. Sent as an absolute value rather than a
   * delta so a dropped request cannot lose time or double-count it — the server
   * keeps the maximum, which makes the write idempotent and order-independent.
   */
  @IsInt()
  @Min(0)
  watchedSeconds!: number;

  /** Where the learner actually is now, so playback can resume there. */
  @IsInt()
  @Min(0)
  positionSeconds!: number;
}

/**
 * Document formats a lesson can carry, as primary content or as a supporting
 * resource. Closed for the same reason the video list is: the presigned URL is
 * signed with the declared content type, so this list IS what can be stored.
 *
 * `application/octet-stream` is deliberately absent — it is what a browser
 * reports when it cannot identify a file, and allowing it would make the
 * signed content type meaningless.
 */
export const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
] as const;

/** Extension used for a stored object, per declared type. */
export const EXTENSION_FOR_DOCUMENT_TYPE: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

/** The coarse kind shown as an icon and a label. */
export const RESOURCE_TYPE_FOR_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'doc',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xls',
  'text/plain': 'other',
  'text/csv': 'xls',
};

export class PresignDocumentDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsIn(ALLOWED_DOCUMENT_TYPES as unknown as string[], {
    message: `contentType must be one of: ${ALLOWED_DOCUMENT_TYPES.join(', ')}`,
  })
  contentType!: string;

  /** Checked before signing so an oversized file is refused up front, and
   *  again against R2 on confirm — a presigned PUT cannot cap its own body. */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes!: number;
}

/**
 * Image formats a course thumbnail may be stored in.
 *
 * Closed like the video and document lists, and for a stronger reason here:
 * the file is written to a directory this server publishes statically, so
 * anything that is not a picture is a file we would be hosting on our own
 * origin. The declared type is checked against the file's own magic bytes
 * before anything is written (`MediaService.uploadCourseThumbnail`) — a
 * multipart Content-Type is written by the client and proves nothing on its own.
 *
 * SVG is deliberately absent: it is a document that can carry script, and it
 * would be served from this origin.
 */
export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export const EXTENSION_FOR_IMAGE_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Size cap for a course thumbnail.
 *
 * A constant rather than an environment variable, unlike the video and
 * document caps. Those vary with what a deployment is willing to store and
 * proxy; a thumbnail is a card-sized picture, and 5 MiB is already generous
 * for one. It is also read by `FileInterceptor`'s multer limit, which is
 * configured where the route is declared and has no ConfigService to ask —
 * so one constant keeps the limit multer enforces and the limit the error
 * message quotes from drifting apart.
 *
 * The client mirrors this number so the admin hears about an oversized file
 * before uploading it (`client/services/api/admin/admin-api.js`). Change both.
 */
export const COURSE_THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The thumbnail the client is rolling back after a failed course save. The
 * value is a stored path, not a key — `ImageStorageService.removeThumbnail`
 * refuses anything that is not one, so an arbitrary path cannot be handed in.
 */
export class DiscardThumbnailDto {
  @IsString()
  @MaxLength(1024)
  url!: string;
}
