import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class CourseDto {
  @IsString()
  @MinLength(1, { message: 'name is required' })
  @Transform(trim)
  name!: string;

  @IsOptional() @Transform(nullable) description?: string | null;
  @IsOptional() @Transform(nullable) thumbnail_url?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class ModuleDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional() @Transform(nullable) description?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class CreateLessonDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional() @Transform(nullable) description?: string | null;
  @IsOptional() @IsString() content_type?: string;
  @IsOptional() @Transform(nullable) content_url?: string | null;
  @IsOptional() @IsInt() scorm_package_id?: number | null;
  @IsOptional() @IsInt() duration_minutes?: number | null;
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsBoolean() is_preview?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

/**
 * Every field optional: the lesson editor sends partial updates, and an absent
 * key must leave the stored value untouched rather than null it out.
 */
export class UpdateLessonDto {
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title?: string;

  @IsOptional() @Transform(nullable) description?: string | null;
  @IsOptional() @IsString() content_type?: string;
  @IsOptional() @Transform(nullable) content_url?: string | null;
  @IsOptional() @IsInt() scorm_package_id?: number | null;
  @IsOptional() @IsInt() duration_minutes?: number | null;
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsBoolean() is_preview?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class CreateAssignmentDto {
  @IsInt({ message: 'user_id must be an integer' })
  user_id!: number;

  @IsOptional() @Transform(nullable) due_date?: string | null;
}
