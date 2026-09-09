import { Transform } from 'class-transformer';
import {
  IsBoolean,
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
 * The DTO for creating a user inside an organization now lives with the
 * endpoint that does it — `modules/roles/dto/platform-user.dto.ts`, for
 * `POST /platform/organizations/:id/users` (`specs/rbac.md` §3.9). What was
 * here, `CreateOrganizationAdminDto`, had no `roleId` because the old
 * endpoint could only make an admin.
 */
