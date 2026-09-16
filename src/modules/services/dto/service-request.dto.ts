import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { SERVICE_NAMES } from '@/common/edstellar-services';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class CreateServiceRequestDto {
  /**
   * Validated against the catalogue, not free text.
   *
   * A request is routed by a human at Edstellar reading this field. One naming
   * a service that is not offered is not a request, it is a dead row — so it
   * is refused with a 422 that lists what IS offered, which is also how a
   * drift between this list and the browser's copy announces itself.
   */
  @IsIn(SERVICE_NAMES, {
    message: 'service must be one of the Edstellar services in the catalogue',
  })
  service!: string;

  /**
   * The per-service questionnaire as answered. Shape varies by service and is
   * decided by the browser's question set, so this validates that it is an
   * object and nothing more — see `0021_service_requests.sql` for why that is
   * the right trade here and what it costs.
   */
  @IsOptional()
  @IsObject({ message: 'answers must be an object' })
  answers?: Record<string, unknown>;

  /** Lifted out of `answers` because the list screen shows them as columns. */
  @IsOptional() @MaxLength(80) @Transform(nullable) timeline?: string | null;
  @IsOptional() @MaxLength(80) @Transform(nullable) budget?: string | null;
}

export class ListServiceRequestsDto {
  /** Paginated (§7.6). Requests accumulate for as long as the org exists. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
