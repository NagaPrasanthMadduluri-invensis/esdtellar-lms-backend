import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * The five groups a learner may mute.
 *
 * Keyed by the catalogue's `group`, not by notification type, and that is
 * the decision that keeps this screen from growing. A 26th notification type
 * drops into an existing group with no UI change, no DTO change and no
 * migration — where a per-type model would need all three every time.
 */
export const MUTABLE_GROUPS = [
  'learning',
  'sessions',
  'recognition',
  'people',
  'commercial',
] as const;

export class UpdateEmailPreferencesDto {
  /**
   * Honoured for everything, transactional included — except a password
   * reset, which ignores it (see `email-types.ts`). Partial honouring would
   * make the checkbox a lie.
   */
  @IsOptional()
  @IsBoolean()
  all_off?: boolean;

  /** Announcements only. Unknown values are dropped by the service. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(MUTABLE_GROUPS as unknown as string[], { each: true })
  groups_off?: string[];
}

export class OutboxQueryDto {
  @IsOptional()
  @IsIn(['pending', 'sending', 'sent', 'failed', 'suppressed'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
