import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase().trim() : value;

/**
 * URL-safe: lowercase letters, digits and single hyphens between them, no
 * leading/trailing hyphen (spec §3.2 — `organizations.slug`).
 */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
}

/**
 * Seeds an organization's FIRST admin. `organizationId` is always taken from
 * the route param (`POST /platform/organizations/:id/admins`), never from
 * this body — the caller cannot name a different organization to seed.
 */
export class CreateOrganizationAdminDto {
  @IsString()
  @MinLength(1, { message: 'firstName is required' })
  @Transform(trim)
  firstName!: string;

  @IsString()
  @MinLength(1, { message: 'lastName is required' })
  @Transform(trim)
  lastName!: string;

  @IsEmail({}, { message: 'email must be a valid email address' })
  @Transform(lower)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  password!: string;
}
