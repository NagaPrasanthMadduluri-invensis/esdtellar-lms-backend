import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  COMMUNITY_BODY_MAX,
  COMMUNITY_HASHTAGS_PER_POST_MAX,
  COMMUNITY_TITLE_MAX,
  KUDOS_MESSAGE_MAX,
} from '@/common/content-limits';

export const COMMUNITY_POST_TYPES = [
  'question',
  'achievement',
  'discussion',
] as const;
export type CommunityPostType = (typeof COMMUNITY_POST_TYPES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreatePostDto {
  @IsIn(COMMUNITY_POST_TYPES, {
    message: 'type must be question, achievement or discussion',
  })
  type!: CommunityPostType;

  @IsOptional()
  @IsString()
  @MaxLength(COMMUNITY_TITLE_MAX)
  @Transform(trim)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COMMUNITY_BODY_MAX)
  @Transform(trim)
  body?: string;

  // The learner's own certificate id (from GET /api/learner/certificates), set
  // only for an achievement post. Ownership + org are re-checked in the service.
  @IsOptional()
  @IsInt()
  @IsPositive()
  certificateId?: number;

  // Raw hashtag tokens from the chip input (with or without a leading #). The
  // service normalises, de-duplicates, requires at least one on a non-kudos
  // post, and merges any #tokens typed inline in the title/body.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COMMUNITY_HASHTAGS_PER_POST_MAX * 2)
  @IsString({ each: true })
  hashtags?: string[];
}

export class CreateKudosDto {
  // The person being recognised — a learner-portal account in the same org,
  // not the caller. Validated in the service.
  @IsInt()
  @IsPositive()
  recipientUserId!: number;

  @IsString()
  @MinLength(1, { message: 'add a short message with your kudos' })
  @MaxLength(KUDOS_MESSAGE_MAX)
  @Transform(trim)
  message!: string;
}

export class CreateReplyDto {
  @IsString()
  @MinLength(1, { message: 'a reply cannot be empty' })
  @MaxLength(COMMUNITY_BODY_MAX)
  @Transform(trim)
  body!: string;
}
