import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_TOO_LONG,
} from '@/common/content-limits';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * A closed list, matching the mock's badge icon picker
 * (`admin-journeys-content.jsx`) — a free-text icon name would let a bad
 * value reach the achievements page as a broken lucide lookup.
 */
const BADGE_ICONS = [
  'award',
  'trophy',
  'star',
  'medal',
  'shield',
  'crown',
  'flag',
  'target',
  'zap',
  'gem',
] as const;

export class JourneyDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(nullable)
  description?: string | null;

  /** e.g. "Sales · Role Path" — the mock's `tag`. */
  @IsOptional()
  @MaxLength(120, { message: 'tag must be at most 120 characters' })
  @Transform(nullable)
  tag?: string | null;

  /** Comma-separated, mirroring the mock's `skills[]`. */
  @IsOptional()
  @MaxLength(255, { message: 'skills must be at most 255 characters' })
  @Transform(nullable)
  skills?: string | null;

  /** Same storage and rules as a course thumbnail (§10.10) — validated by MediaService. */
  @IsOptional()
  @Transform(nullable)
  thumbnail_url?: string | null;

  @IsString()
  @MinLength(1, { message: 'badge_label is required' })
  @MaxLength(120, { message: 'badge_label must be at most 120 characters' })
  @Transform(trim)
  badge_label!: string;

  @IsOptional()
  @IsIn(BADGE_ICONS, { message: `badge_icon must be one of ${BADGE_ICONS.join(', ')}` })
  badge_icon?: (typeof BADGE_ICONS)[number];

  @IsOptional()
  @IsInt({ message: 'points_bonus must be an integer' })
  @Min(0)
  @Max(100000)
  points_bonus?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class JourneyCourseItemDto {
  @IsInt({ message: 'course_id must be an integer' })
  course_id!: number;

  @IsOptional()
  @IsInt({ message: 'sort_order must be an integer' })
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;
}

/**
 * Replaces the journey's whole course list, in order. At least 2 — a
 * "journey" of one course is a course assignment (spec §6 acceptance 1).
 */
export class SetJourneyCoursesDto {
  @IsArray()
  @ArrayMinSize(2, { message: 'A journey needs at least 2 courses' })
  @ValidateNested({ each: true })
  @Type(() => JourneyCourseItemDto)
  courses!: JourneyCourseItemDto[];
}

export class ListJourneysQueryDto {
  @IsOptional()
  @IsIn(['active', 'draft'], { message: 'status must be active or draft' })
  status?: 'active' | 'draft';

  /**
   * Archived paths instead of live ones. A SWAP, not an extra filter — the two
   * sets are never shown together (see `listForAdmin`).
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  archived?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(100, { message: 'limit must be at most 100' })
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset must be an integer' })
  @Min(0)
  offset: number = 0;
}

export class ListJourneyLearnersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(100, { message: 'limit must be at most 100' })
  limit: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset must be an integer' })
  @Min(0)
  offset: number = 0;
}


/** Pagination for the learner's own journey list (§7.6). */
export class ListLearnerJourneysQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** Bulk action over a selection of paths, from the builder's action bar. */
export class BulkJourneysDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one learning path' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'ids must be integers' })
  ids!: number[];

  @IsIn(['activate', 'draft', 'archive', 'restore', 'delete'], {
    message: 'action must be one of: activate, draft, archive, restore, delete',
  })
  action!: 'activate' | 'draft' | 'archive' | 'restore' | 'delete';
}
