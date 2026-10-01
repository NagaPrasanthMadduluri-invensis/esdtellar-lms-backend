import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_TOO_LONG,
} from '@/common/content-limits';
import {
  EXTERNAL_CERT_STATUSES,
  MAX_CLAIMED_HOURS,
} from '@/common/external-certifications';

/**
 * A learner's claim. Every message LEADS WITH THE FIELD NAME —
 * `HttpExceptionFilter.group()` buckets constraint strings by their first
 * word to build the `errors` map (§8.1), and this is the one form in the
 * product where a learner is typing five required fields at once, so the
 * form marking the right one matters more than usual.
 *
 * It arrives as multipart alongside the file, so every value is a STRING on
 * the wire — hence `@Type(() => Number)` on the hours.
 */
export class SubmitExternalCertificationDto {
  @IsString({ message: 'name_on_certificate is required' })
  @MinLength(1, { message: 'name_on_certificate is required' })
  @MaxLength(160, { message: 'name_on_certificate must be 160 characters or fewer' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name_on_certificate!: string;

  @IsString({ message: 'course_name is required' })
  @MinLength(1, { message: 'course_name is required' })
  @MaxLength(200, { message: 'course_name must be 200 characters or fewer' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  course_name!: string;

  /**
   * HOURS on the wire, minutes in the database — the form asks the way a
   * certificate is written and the service converts once at the boundary.
   * Quarter-hours are allowed because plenty of courses are 1.5 or 2.5.
   */
  @Type(() => Number)
  @IsNumber({}, { message: 'course_hours must be a number' })
  @Min(0.25, { message: 'course_hours must be at least 0.25' })
  @Max(MAX_CLAIMED_HOURS, {
    message: `course_hours must be ${MAX_CLAIMED_HOURS} or fewer`,
  })
  course_hours!: number;

  @IsString({ message: 'authorized_body is required' })
  @MinLength(1, { message: 'authorized_body is required' })
  @MaxLength(160, { message: 'authorized_body must be 160 characters or fewer' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  authorized_body!: string;
}

/**
 * A manager's or an admin's decision.
 *
 * A note is optional on an approval and REQUIRED on a refusal — the service
 * enforces the second, not this DTO, because the rule depends on `approve`
 * and a DTO cannot see across its own fields without a custom validator.
 * Telling somebody their evidence was not accepted without saying why is the
 * one outcome here that leaves them with nothing to do next.
 */
export class DecideExternalCertificationDto {
  @IsBoolean({ message: 'approve must be true or false' })
  approve!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  note?: string | null;
}

/** What the admin queue is asking for. */
export class ListExternalCertificationsQueryDto {
  @IsOptional()
  @IsIn(EXTERNAL_CERT_STATUSES, {
    message: `status must be one of: ${EXTERNAL_CERT_STATUSES.join(', ')}`,
  })
  status?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
