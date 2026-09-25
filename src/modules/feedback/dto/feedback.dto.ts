import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_TOO_LONG,
} from '@/common/content-limits';
import { RATING_MAX, RATING_MIN } from '@/common/feedback';

/**
 * A learner's rating of one session.
 *
 * All three ratings are REQUIRED. A partially answered form produces a row
 * that skews every average it appears in, and a nullable rating would force
 * every `AVG()` in the repository to explain which responses it counted.
 * The browser requires all three before Save for the same reason; this is
 * what enforces it.
 *
 * `sessionId` is NOT in this DTO — it comes from the path, so a learner
 * cannot rate one session through another's URL.
 *
 * Every message LEADS WITH THE FIELD NAME, which is not decoration:
 * `HttpExceptionFilter`'s `group()` buckets constraint strings by their first
 * word to build the `errors` map (§8.1). Friendlier prose here ("Course
 * content rating must be 1-5") filed the failure under "Course" and the map
 * stopped naming the field it was about. The UI only ever offers 1 to 5, so
 * nobody reads these except a caller sending a malformed body.
 */
export class SubmitFeedbackDto {
  @Type(() => Number)
  @IsInt({ message: 'rating_content must be a whole number' })
  @Min(RATING_MIN, { message: `rating_content must be from ${RATING_MIN} to ${RATING_MAX}` })
  @Max(RATING_MAX, { message: `rating_content must be from ${RATING_MIN} to ${RATING_MAX}` })
  rating_content!: number;

  @Type(() => Number)
  @IsInt({ message: 'rating_trainer must be a whole number' })
  @Min(RATING_MIN, { message: `rating_trainer must be from ${RATING_MIN} to ${RATING_MAX}` })
  @Max(RATING_MAX, { message: `rating_trainer must be from ${RATING_MIN} to ${RATING_MAX}` })
  rating_trainer!: number;

  @Type(() => Number)
  @IsInt({ message: 'rating_delivery must be a whole number' })
  @Min(RATING_MIN, { message: `rating_delivery must be from ${RATING_MIN} to ${RATING_MAX}` })
  @Max(RATING_MAX, { message: `rating_delivery must be from ${RATING_MIN} to ${RATING_MAX}` })
  rating_delivery!: number;

  /**
   * Optional, and capped at the same 450 every other free-text field uses
   * (§8.5) — an admin should never discover by being refused that one form
   * is stricter than another.
   *
   * An empty string is normalised to null so "submitted with no comment" and
   * "submitted with a blank comment" are one state, not two.
   */
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  comment?: string | null;
}

/** Paging for the trainer's feedback list — every list is paginated (§7.6). */
export class ListFeedbackQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  session_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
