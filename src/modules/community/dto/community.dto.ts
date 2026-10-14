import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { COMMUNITY_BODY_MAX, COMMUNITY_TITLE_MAX } from '@/common/content-limits';

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
}

export class CreateReplyDto {
  @IsString()
  @MinLength(1, { message: 'a reply cannot be empty' })
  @MaxLength(COMMUNITY_BODY_MAX)
  @Transform(trim)
  body!: string;
}
