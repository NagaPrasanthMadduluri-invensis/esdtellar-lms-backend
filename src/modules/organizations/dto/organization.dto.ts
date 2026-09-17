import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsEmail,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { BILLING_CYCLES, PLANS } from '@/common/tenant-account';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Omitted stays undefined (leave alone); an explicit blank becomes null. */
const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase().trim() : value;

/**
 * URL-safe: lowercase letters, digits and single hyphens between them, no
 * leading/trailing hyphen (spec §3.2 — `organizations.slug`).
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The tenant's first admin. REQUIRED, and created in the same transaction as
 * the organization.
 *
 * Provisioning an organization without one produces a tenant nobody can log
 * into — a state the directory now renders as a warning, and not one a form
 * should be able to create by omission.
 */
export class NewTenantAdminDto {
  @IsString() @MinLength(1, { message: 'admin first name is required' })
  @MaxLength(80) @Transform(trim)
  firstName!: string;

  @IsString() @MinLength(1, { message: 'admin last name is required' })
  @MaxLength(80) @Transform(trim)
  lastName!: string;

  @IsEmail({}, { message: 'admin email must be a valid email address' })
  @MaxLength(160) @Transform(lower)
  email!: string;

  /** Same floor the admin user form uses, so one rule across both screens. */
  @IsString() @MinLength(6, { message: 'password must be at least 6 characters' })
  @MaxLength(200)
  password!: string;
}

export class CreateOrganizationDto {
  @IsString()
  @MinLength(1, { message: 'name is required' })
  @Transform(trim)
  name!: string;

  /**
   * Optional — `OrganizationsService.deriveSlug` derives one from `name` when
   * omitted. When supplied it must already be URL-safe; a duplicate is a 409,
   * never a 422, since the conflict is with existing data, not malformed input.
   */
  @IsOptional()
  @IsString()
  @Matches(SLUG_PATTERN, {
    message: 'slug must be lowercase letters, digits and hyphens only',
  })
  @Transform(lower)
  slug?: string;

  /*
   * `@IsDefined` is load-bearing, not belt-and-braces.
   *
   * `@ValidateNested` alone SKIPS an undefined value, so a body with no
   * `admin` key passed validation and the service then dereferenced
   * `dto.admin.email` — a TypeError, which the exception filter correctly
   * turns into a bare 500 (§8.3). The caller was told "Internal server error"
   * for a field they simply forgot.
   */
  @IsDefined({
    message:
      'admin is required — an organization with no admin account cannot be signed into',
  })
  @IsObject({ message: 'admin must be an object' })
  @ValidateNested()
  @Type(() => NewTenantAdminDto)
  admin!: NewTenantAdminDto;

  /* ── Profile and contract, all optional.
        Accepted at creation so a super admin provisioning a signed account
        does not have to create it blank and immediately reopen the edit
        dialog to type what the contract already says. ── */

  @IsOptional() @MaxLength(80) @Transform(nullable) industry?: string | null;
  @IsOptional() @MaxLength(80) @Transform(nullable) region?: string | null;

  // `PLANS` is a tuple of values, not an object — `Object.keys` on it yields
  // "0","1","2" and rejects every real plan. Same validators as
  // `UpdateOrganizationDto` below, message included, so a typo is refused
  // identically whichever form sent it.
  @IsOptional()
  @IsIn(PLANS, { message: `plan must be one of: ${PLANS.join(', ')}` })
  @Transform(nullable) plan?: string | null;

  @IsOptional()
  @IsIn(BILLING_CYCLES, {
    message: `billingCycle must be one of: ${BILLING_CYCLES.join(', ')}`,
  })
  @Transform(nullable) billingCycle?: string | null;

  @IsOptional() @Transform(nullable) contractStart?: string | null;
  @IsOptional() @Transform(nullable) contractEnd?: string | null;

  @IsOptional() @IsNumber({}, { message: 'contractValue must be a number' })
  @Min(0) @Type(() => Number) contractValue?: number | null;

  @IsOptional() @IsNumber({}, { message: 'seatLimit must be a number' })
  @Min(1) @Type(() => Number) seatLimit?: number | null;
}

/** Renames and/or activates/deactivates. Deactivating never deletes anything. */
export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'name is required' })
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsBoolean({ message: 'isActive must be a boolean' })
  isActive?: boolean;

  /* ── Tenant profile & contract (0026).
        Every field OPTIONAL and omitted-means-leave-alone, so the directory's
        edit form can send only what it changed. That matters here more than
        usual: blanking a contract value because a form posted the whole object
        would rewrite a commercial term nobody touched (§10.10 makes the same
        distinction for thumbnails). ── */

  @IsOptional() @MaxLength(80) @Transform(nullable) industry?: string | null;
  @IsOptional() @MaxLength(80) @Transform(nullable) region?: string | null;
  @IsOptional() @MaxLength(120) @Transform(nullable) contactName?: string | null;
  @IsOptional() @MaxLength(160) @Transform(nullable) contactEmail?: string | null;
  @IsOptional() @MaxLength(40) @Transform(nullable) contactPhone?: string | null;

  @IsOptional() @Transform(nullable) contractStart?: string | null;
  @IsOptional() @Transform(nullable) contractEnd?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'contractValue must be a number' })
  @Min(0, { message: 'contractValue cannot be negative' })
  contractValue?: number | null;

  @IsOptional()
  @IsIn(PLANS, { message: `plan must be one of: ${PLANS.join(', ')}` })
  plan?: string | null;

  @IsOptional()
  @IsIn(BILLING_CYCLES, {
    message: `billingCycle must be one of: ${BILLING_CYCLES.join(', ')}`,
  })
  billingCycle?: string | null;

  @IsOptional() @MaxLength(2000) @Transform(nullable) notes?: string | null;
}

/**
 * The DTO for creating a user inside an organization now lives with the
 * endpoint that does it — `modules/roles/dto/platform-user.dto.ts`, for
 * `POST /platform/organizations/:id/users` (`specs/rbac.md` §3.9). What was
 * here, `CreateOrganizationAdminDto`, had no `roleId` because the old
 * endpoint could only make an admin.
 */
