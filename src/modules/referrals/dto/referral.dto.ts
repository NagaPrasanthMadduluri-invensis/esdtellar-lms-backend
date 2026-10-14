import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { REFERRAL_STATUSES } from '@/common/referrals';
import { DESCRIPTION_MAX_LENGTH } from '@/common/content-limits';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * File a referral.
 *
 * Everything identifying the REFERRER (the org, the user id, the name and email
 * the referral is signed with) is taken from the VERIFIED TOKEN, never the body
 * — the same rule `CreateServiceRequestDto` follows, and it matters more here
 * because the output leaves the building as an email on Edstellar's brand. The
 * body carries only the PROSPECT's details.
 */
export class CreateReferralDto {
  @IsString()
  @Transform(trim)
  @MinLength(1, { message: 'company_name is required' })
  @MaxLength(160, { message: 'company_name must be 160 characters or fewer' })
  company_name!: string;

  @IsString()
  @Transform(trim)
  @MinLength(1, { message: 'contact_name is required' })
  @MaxLength(120, { message: 'contact_name must be 120 characters or fewer' })
  contact_name!: string;

  @IsEmail({}, { message: 'contact_email must be a valid email address' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @MaxLength(255)
  contact_email!: string;

  @IsOptional() @MaxLength(40) @Transform(nullable) contact_phone?: string | null;
  @IsOptional() @MaxLength(80) @Transform(nullable) industry?: string | null;
  @IsOptional() @MaxLength(80) @Transform(nullable) country?: string | null;
  @IsOptional() @MaxLength(40) @Transform(nullable) team_size?: string | null;

  /** Why they would be a fit. Capped like every other free-text note (§8.5). */
  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, {
    message: `notes must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`,
  })
  @Transform(nullable)
  notes?: string | null;
}

export class ListReferralsDto {
  /** Paginated (§7.6). Referrals accumulate for as long as the org exists. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * Edstellar's response. PLATFORM ONLY — there is deliberately no tenant-facing
 * route that writes `status`, or a tenant could mark its own referral
 * "converted" and earn itself a discount.
 */
export class RespondToReferralDto {
  @IsIn(REFERRAL_STATUSES, {
    message: `status must be one of: ${REFERRAL_STATUSES.join(', ')}`,
  })
  status!: string;

  /** What the referring admin reads back on their own referral. */
  @IsOptional()
  @MaxLength(1000, { message: 'platform_note must be 1000 characters or fewer' })
  @Transform(nullable)
  platform_note?: string | null;

  /**
   * The tenant the prospect became, set when moving a referral to `converted`.
   * Optional: a conversion can be recorded before the org is provisioned, and
   * linked later. Validated against real tenant orgs in the service.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  converted_organization_id?: number | null;
}

/** Filters for the platform queue. */
export class ListPlatformReferralsDto {
  @IsOptional()
  @IsIn(REFERRAL_STATUSES, {
    message: `status must be one of: ${REFERRAL_STATUSES.join(', ')}`,
  })
  status?: string;

  @IsOptional() @Type(() => Number) @IsInt() organization_id?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
