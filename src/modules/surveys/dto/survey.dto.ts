import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_TOO_LONG,
} from '@/common/content-limits';
import {
  FEEDBACK_QUESTION_TYPE_IDS,
  MAX_TEMPLATE_QUESTIONS,
} from '@/common/feedback-questions';

/**
 * Every message LEADS WITH THE FIELD NAME. `HttpExceptionFilter.group()`
 * buckets constraint strings by their first word to build the `errors` map
 * (§8.1), so friendlier prose files the failure under the wrong key and the
 * form cannot mark the field that is wrong.
 */

const PROMPT_MAX = 300;

export class TemplateQuestionDto {
  @IsIn(FEEDBACK_QUESTION_TYPE_IDS, {
    message: `question_type must be one of: ${FEEDBACK_QUESTION_TYPE_IDS.join(', ')}`,
  })
  question_type!: string;

  @IsString({ message: 'prompt is required' })
  @MinLength(1, { message: 'prompt is required' })
  @MaxLength(PROMPT_MAX, {
    message: `prompt must be ${PROMPT_MAX} characters or fewer`,
  })
  prompt!: string;

  /**
   * Only `choice` uses it. The service refuses a `choice` with fewer than two
   * and strips it from every other type — a stored option list nothing renders
   * is a field that lies about what the learner will see.
   */
  @IsOptional()
  @IsArray({ message: 'options must be a list of choices' })
  @ArrayMaxSize(10, { message: 'options must be 10 choices or fewer' })
  @IsString({ each: true, message: 'options must be a list of choices' })
  options?: string[];

  @IsOptional()
  @IsBoolean({ message: 'is_required must be true or false' })
  is_required?: boolean;
}

export class SaveTemplateDto {
  @IsString({ message: 'name is required' })
  @MinLength(1, { message: 'name is required' })
  @MaxLength(120, { message: 'name must be 120 characters or fewer' })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  description?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'is_active must be true or false' })
  is_active?: boolean;

  /**
   * The WHOLE question set, in order. Sent on create and on every save,
   * because the editor always holds the complete list — a diff would be a
   * slower route to the same rows, the same reasoning `replaceCourses` uses
   * for a journey.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TEMPLATE_QUESTIONS, {
    message: `questions must be ${MAX_TEMPLATE_QUESTIONS} or fewer`,
  })
  @ValidateNested({ each: true })
  @Type(() => TemplateQuestionDto)
  questions?: TemplateQuestionDto[];
}

/** What a learner sends back. Keyed by question id; the service validates. */
export class SubmitCourseFeedbackDto {
  @IsObject({ message: 'answers must be an object keyed by question id' })
  answers!: Record<string, unknown>;
}

/** Paging for the admin's responses list — every list is paginated (§7.6). */
export class ListResponsesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  course_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  template_id?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
