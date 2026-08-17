import { IsIn, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

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
}
