import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

import {
  DATA_REQUEST_TYPES,
  DATA_REQUEST_STATUSES,
} from '@/common/data-requests';
import { DESCRIPTION_MAX_LENGTH } from '@/common/content-limits';
import { MaxLength } from 'class-validator';

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * File a correction or deletion request. The subject is taken from the VERIFIED
 * TOKEN, never the body (§5.3) — a request can only ever be about the caller's
 * own data.
 */
export class CreateDataRequestDto {
  @IsIn(DATA_REQUEST_TYPES, {
    message: `type must be one of: ${DATA_REQUEST_TYPES.join(', ')}`,
  })
  type!: string;

  /** What to correct, or why deletion is wanted. Capped like every note (§8.5). */
  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `details must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`,
  })
  @Transform(nullable)
  details?: string | null;
}

export class ListMyDataRequestsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** The admin filter for the queue. */
export class ListDataRequestsDto {
  @IsOptional()
  @IsIn(DATA_REQUEST_STATUSES, {
    message: `status must be one of: ${DATA_REQUEST_STATUSES.join(', ')}`,
  })
  status?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * The admin's response. PLATFORM-of-the-tenant only via the admin controller —
 * the subject cannot move their own request's status.
 */
export class ResolveDataRequestDto {
  @IsIn(DATA_REQUEST_STATUSES, {
    message: `status must be one of: ${DATA_REQUEST_STATUSES.join(', ')}`,
  })
  status!: string;

  @IsOptional()
  @MaxLength(1000, { message: 'admin_note must be 1000 characters or fewer' })
  @Transform(nullable)
  admin_note?: string | null;
}
