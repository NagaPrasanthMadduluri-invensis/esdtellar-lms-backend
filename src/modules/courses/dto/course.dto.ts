import { Transform, Type } from 'class-transformer';
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

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_TOO_LONG,
} from '@/common/content-limits';
import { COURSE_CATEGORIES, RENEWAL_MONTHS } from '@/common/course-taxonomy';
import { LESSON_CONTENT_KEYS } from '@/common/lesson-content';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Like `nullable`, but an absent value stays absent instead of becoming null,
 * so a caller that did not mention the field can be told apart from one that
 * asked to clear it.
 */
const keepUndefined = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  return nullable({ value });
};

export class CourseDto {
  @IsString()
  @MinLength(1, { message: 'name is required' })
  @Transform(trim)
  name!: string;

  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(nullable)
  description?: string | null;

  /**
   * Three distinct meanings, and the DTO has to preserve all three — which is
   * why this does NOT use `nullable` like the field above it:
   *
   *   absent  → leave the course's current picture alone
   *   null    → remove it, fall back to the generated artwork
   *   string  → set it
   *
   * `nullable` collapses the first two into null, and with it every edit that
   * did not resend the thumbnail silently cleared it — renaming a course
   * removed its picture. `keepUndefined` maps "" to null (an emptied field is
   * a removal) and leaves undefined as undefined.
   */
  @IsOptional() @Transform(keepUndefined) thumbnail_url?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;

  /** Closed list — the library colours and filters by it (course-taxonomy.ts). */
  @IsOptional()
  @Transform(nullable)
  @IsIn(COURSE_CATEGORIES, {
    message: `category must be one of: ${COURSE_CATEGORIES.join(', ')}`,
  })
  category?: string | null;

  /**
   * Setting this on a Compliance course is redundant but harmless: the service
   * does not read it for that category, because `isMandatory()` already
   * returns true. Unsetting it there is likewise ignored, which is the point —
   * a compliance course cannot be made optional by unticking a box.
   */
  @IsOptional() @IsBoolean() is_mandatory?: boolean;

  /**
   * Whole months, from a fixed set. A free integer invites 1 (not a training
   * programme) and 999 (not a renewal). Null clears it.
   */
  @IsOptional()
  @IsIn([...RENEWAL_MONTHS, null], {
    message: `expiry_months must be one of: ${RENEWAL_MONTHS.join(', ')}`,
  })
  expiry_months?: number | null;

  /**
   * Free text, comma-separated. Deliberately NOT a closed list: nothing
   * filters or branches on a tag, so a typo costs a missed search hit and
   * nothing else — which is the test for when free text is safe.
   */
  @IsOptional() @MaxLength(300) @Transform(nullable) tags?: string | null;
}

/** Which courses the admin library is asking for. */
export class CourseListQueryDto {
  /**
   * `true` swaps the list to the archive. Archived courses are excluded by
   * default rather than mixed in and filtered client-side — an archived course
   * appearing in the picker that assigns learning is the thing archiving is
   * for.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  archived?: boolean;
}

/** Bulk publish / unpublish / archive / restore over selected courses. */
export class BulkCourseActionDto {
  @IsIn(['publish', 'unpublish', 'archive', 'restore'], {
    message: 'action must be publish, unpublish, archive or restore',
  })
  action!: 'publish' | 'unpublish' | 'archive' | 'restore';

  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one course' })
  @IsInt({ each: true })
  course_ids!: number[];
}

export class ModuleDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(nullable)
  description?: string | null;
  @IsOptional() @IsBoolean() is_active?: boolean;

  /** Position within the course. Omitted on edit means "leave where it is". */
  @IsOptional() @IsInt() @Min(0) sort_order?: number;
}

export class CreateLessonDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(nullable)
  description?: string | null;
  /**
   * Closed list (`common/lesson-content.ts`). Each type carries its own
   * upload and duration rule, so a value outside the list has no rule and
   * would skip validation entirely.
   */
  @IsOptional()
  @IsIn(LESSON_CONTENT_KEYS, {
    message: `content_type must be one of: ${LESSON_CONTENT_KEYS.join(', ')}`,
  })
  content_type?: string;

  /**
   * Optional on create. Omitted means STAGED — authored but not yet placed in
   * a module, so invisible to learners and counting for nothing until linked.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) module_id?: number | null;

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

  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(nullable)
  description?: string | null;
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

/** Move a lesson into a module, or back to staged. */
export class LinkLessonDto {
  /**
   * `null` unlinks — back to staged. Nullable rather than optional so
   * "unlink" is an explicit instruction and not the absence of one.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'module_id must be an integer or null' })
  @Min(1)
  module_id!: number | null;
}
