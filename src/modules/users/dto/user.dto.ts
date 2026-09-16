import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { JOB_LEVELS, LOCATIONS } from '@/common/workforce';

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
  @IsIn(LOCATIONS, { message: `location must be one of: ${LOCATIONS.join(', ')}` })
  location?: string | null;

  /** Deliberately free text — it is a job title, not a reporting dimension. */
  @IsOptional()
  @Transform(nullable)
  job_role?: string | null;

  /** Closed list. This is the Reports "Job Level" filter and comparison axis. */
  @IsOptional()
  @Transform(nullable)
  @IsIn(JOB_LEVELS, { message: `job_level must be one of: ${JOB_LEVELS.join(', ')}` })
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

  @IsOptional()
  @Transform(nullable)
  @IsIn(LOCATIONS, { message: `location must be one of: ${LOCATIONS.join(', ')}` })
  location?: string | null;

  @IsOptional()
  @Transform(nullable)
  job_role?: string | null;

  @IsOptional()
  @Transform(nullable)
  @IsIn(JOB_LEVELS, { message: `job_level must be one of: ${JOB_LEVELS.join(', ')}` })
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
