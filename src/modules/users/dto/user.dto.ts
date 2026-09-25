import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
  IsInt,
} from 'class-validator';


const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase().trim() : value;

/** Empty strings arrive from the admin form; normalise them to null. */
const nullable = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class CreateUserDto {
  @IsString()
  @MinLength(1, { message: 'first_name is required' })
  @Transform(trim)
  first_name!: string;

  @IsString()
  @MinLength(1, { message: 'last_name is required' })
  @Transform(trim)
  last_name!: string;

  @IsEmail({}, { message: 'email must be a valid email address' })
  @Transform(lower)
  email!: string;

  @IsString()
  @MinLength(6, { message: 'password must be at least 6 characters' })
  password!: string;

  /**
   * Which of the organization's roles the new account holds. Optional: omitted
   * means the `learner` role, which is what every caller sent before this
   * existed and what the bulk import still sends.
   *
   * It is a ROLE ID, not a portal or a role key. The portal is derived from
   * the role row (`users.role` is written from `roles.portal`), so a caller
   * cannot put somebody on the trainer portal while holding a learner role —
   * the two columns cannot be made to disagree from outside.
   *
   * The service checks the id belongs to the caller's own organization and
   * 404s otherwise, for the reason `RolesService.assign` already documents: a
   * role id from another tenant must not be distinguishable from one that
   * does not exist.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'role_id must be a role in this organization' })
  role_id?: number;

  /**
   * Who this person reports to, and therefore whose Team Learning they appear
   * in. Optional; an explicit null clears it (§10.10's patch semantics).
   *
   * Validated in the service, not here: the checks are "is this a real active
   * user in the SAME organization", "is it not themselves" and "does it not
   * create a cycle", and none of those is knowable from the value alone.
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === null || value === undefined ? null : Number(value),
  )
  manager_id?: number | null;

  @IsOptional()
  @Transform(nullable)
  department?: string | null;

  /**
   * Closed list (`common/workforce.ts`). Free text here is what produced two
   * spellings of one office and made the location filter in Reports unable to
   * see three learners at all.
   */
  @IsOptional()
  @Transform(nullable)
  // Checked against THIS organization's branch locations in the service,
  // not here: the valid set became a per-tenant query in `0031` and a
  // decorator is evaluated at import time. See `UsersService`.
  @IsString() @MaxLength(120)
  location?: string | null;

  /** Deliberately free text — it is a job title, not a reporting dimension. */
  @IsOptional()
  @Transform(nullable)
  job_role?: string | null;

  /** Closed list. This is the Reports "Job Level" filter and comparison axis. */
  @IsOptional()
  @Transform(nullable)
  // Same — validated per organization in the service.
  @IsString() @MaxLength(120)
  job_level?: string | null;
}

export class UpdateUserDto {
  @IsString()
  @MinLength(1, { message: 'first_name is required' })
  @Transform(trim)
  first_name!: string;

  @IsString()
  @MinLength(1, { message: 'last_name is required' })
  @Transform(trim)
  last_name!: string;

  @IsEmail({}, { message: 'email must be a valid email address' })
  @Transform(lower)
  email!: string;

  /**
   * Present here as well as on create. It was missing, so an admin could set a
   * department when adding somebody and never change it afterwards — and
   * department is the dimension every report groups by first.
   */
  @IsOptional()
  @Transform(nullable)
  department?: string | null;

  /**
   * Who this person reports to. An explicit null clears it; omitting the key
   * leaves it alone (§10.10). Validated in the service — same organization,
   * not themselves, and no cycle.
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === '' || value === null || value === undefined ? null : Number(value),
  )
  manager_id?: number | null;

  @IsOptional()
  @Transform(nullable)
  // Checked against THIS organization's branch locations in the service,
  // not here: the valid set became a per-tenant query in `0031` and a
  // decorator is evaluated at import time. See `UsersService`.
  @IsString() @MaxLength(120)
  location?: string | null;

  @IsOptional()
  @Transform(nullable)
  job_role?: string | null;

  @IsOptional()
  @Transform(nullable)
  // Same — validated per organization in the service.
  @IsString() @MaxLength(120)
  job_level?: string | null;
}

export class ToggleActiveDto {
  @IsBoolean({ message: 'is_active must be a boolean' })
  is_active!: boolean;
}

export class BulkUserRowDto {
  @IsOptional() @Transform(nullable) employee_id?: string | null;
  @IsOptional() @Transform(trim) first_name?: string;
  @IsOptional() @Transform(trim) last_name?: string;
  @IsOptional() @Transform(lower) email?: string;
  @IsOptional() @Transform(nullable) department?: string | null;
  @IsOptional() @Transform(nullable) location?: string | null;
  @IsOptional() @Transform(nullable) job_role?: string | null;
  @IsOptional() @Transform(nullable) job_level?: string | null;
  @IsOptional() @Transform(trim) password?: string;
}

/**
 * Row-level validation is done in the service, not here, because a bad row must
 * be reported in the `failed` array rather than rejecting the whole upload.
 */
export class BulkCreateUsersDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'users must contain at least one row' })
  @ArrayMaxSize(500, { message: 'users must contain at most 500 rows' })
  @ValidateNested({ each: true })
  @Type(() => BulkUserRowDto)
  users!: BulkUserRowDto[];
}
