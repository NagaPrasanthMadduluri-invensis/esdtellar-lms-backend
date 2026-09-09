import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase().trim() : value;

/**
 * A super-admin creating a user inside an organization —
 * `POST /api/platform/organizations/:organizationId/users`, `specs/rbac.md`
 * §3.9.
 *
 * `organizationId` is deliberately NOT a field here: it comes from the route
 * param, so the body can never name a different organization to create into.
 * The same rule the old `/admins` DTO followed, kept for the same reason.
 *
 * There is no `role` or `portal` field either. Both are derived server-side
 * from the resolved role (§3.4) — a caller who could send `role: 'admin'`
 * alongside a learner `roleId` would be choosing which portal a user lands in
 * independently of what they may actually do.
 */
export class CreateOrganizationUserDto {
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

  /** Must be a role of THIS organization — the service 404s otherwise. */
  @IsInt({ message: 'roleId is required' })
  roleId!: number;

  /**
   * Optional, and normalised on write: department is free text backing a
   * security boundary (`specs/rbac.md` §8.2), so trimming here is the cheap
   * half of the mitigation that stops `"Engineering "` becoming a second
   * department nobody can see the difference between.
   */
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  department?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  jobRole?: string;
}
