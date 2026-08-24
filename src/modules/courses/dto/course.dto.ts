import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
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

  /**
   * The primary document, when this lesson IS a document and it was uploaded.
   * The key comes from `POST /admin/media/document/presign`; the service
   * proves the object exists in storage before recording it. A document that
   * is linked instead of uploaded uses `content_url` and leaves these null.
   */
  @IsOptional() @Transform(nullable) document_key?: string | null;
  @IsOptional() @Transform(nullable) @MaxLength(255) document_name?: string | null;
  @IsOptional() @Transform(nullable) @MaxLength(255) document_mime?: string | null;
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

  /**
   * The primary document, when this lesson IS a document and it was uploaded.
   * The key comes from `POST /admin/media/document/presign`; the service
   * proves the object exists in storage before recording it. A document that
   * is linked instead of uploaded uses `content_url` and leaves these null.
   */
  @IsOptional() @Transform(nullable) document_key?: string | null;
  @IsOptional() @Transform(nullable) @MaxLength(255) document_name?: string | null;
  @IsOptional() @Transform(nullable) @MaxLength(255) document_mime?: string | null;
  @IsOptional() @IsInt() sort_order?: number;
  @IsOptional() @IsBoolean() is_preview?: boolean;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class BulkAssignmentDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one learner' })
  @IsInt({ each: true, message: 'user_ids must be integers' })
  user_ids!: number[];

  @IsOptional() @Transform(nullable) due_date?: string | null;
}

export class CreateAssignmentDto {
  @IsInt({ message: 'user_id must be an integer' })
  user_id!: number;

  @IsOptional() @Transform(nullable) due_date?: string | null;
}

/** pdf | ppt | doc | xls | link | other — the icon and label, nothing more. */
export const RESOURCE_TYPES = ['pdf', 'ppt', 'doc', 'xls', 'link', 'other'] as const;

/**
 * Supporting material on a lesson: an uploaded file or an external link.
 *
 * `source` decides which of the two halves must be present, and the service
 * enforces that — a row with neither a key nor a URL points at nothing, and a
 * row with both is ambiguous about which one the learner should get.
 */
export class CreateResourceDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @MaxLength(255)
  @Transform(trim)
  title!: string;

  @IsIn(['upload', 'link'], { message: 'source must be upload or link' })
  source!: 'upload' | 'link';

  /** Present when source is `upload` — the presigned key the browser PUT to. */
  @IsOptional() @Transform(nullable) @MaxLength(512) file_key?: string | null;
  @IsOptional() @Transform(nullable) @MaxLength(255) file_name?: string | null;
  @IsOptional() @Transform(nullable) @MaxLength(255) mime_type?: string | null;

  /** Present when source is `link`. */
  @IsOptional() @Transform(nullable) @MaxLength(2048) url?: string | null;

  @IsOptional()
  @IsIn(RESOURCE_TYPES as unknown as string[], {
    message: `resource_type must be one of: ${RESOURCE_TYPES.join(', ')}`,
  })
  resource_type?: string;

  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}
