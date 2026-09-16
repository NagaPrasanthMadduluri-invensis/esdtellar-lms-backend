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
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_TOO_LONG,
} from '@/common/content-limits';
import {
  ASSESSMENT_LINK_TYPES,
  QUESTION_TYPE_KEYS,
} from '@/common/assessment-questions';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class AssessmentDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(nullable)
  description?: string | null;
  @IsOptional() @IsInt() passing_score?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;

  /**
   * Where the assessment sits: the course's final, a module, a lesson, or
   * `none` while it is being written.
   *
   * Stored rather than derived: `course` and `none` both carry neither id and
   * mean opposite things.
   */
  @IsOptional()
  @IsIn(ASSESSMENT_LINK_TYPES, {
    message: `link_type must be one of: ${ASSESSMENT_LINK_TYPES.join(', ')}`,
  })
  link_type?: string;

  /** Required when link_type is 'module'; ignored otherwise. */
  @IsOptional() @IsInt() module_id?: number | null;

  /** Required when link_type is 'lesson'; ignored otherwise. */
  @IsOptional() @IsInt() lesson_id?: number | null;
}

export class OptionDto {
  @IsString()
  @MinLength(1, { message: 'option_text is required' })
  option_text!: string;

  @IsOptional() @IsBoolean() is_correct?: boolean;
}

export class QuestionDto {
  @IsString()
  @MinLength(1, { message: 'question_text is required' })
  @Transform(trim)
  question_text!: string;

  @IsOptional() @IsInt() marks?: number;

  /** One of `QUESTION_TYPES` (`common/assessment-questions.ts`). */
  @IsOptional()
  @IsIn(QUESTION_TYPE_KEYS, {
    message: `question_type must be one of: ${QUESTION_TYPE_KEYS.join(', ')}`,
  })
  question_type?: string;

  /**
   * The answer for the types that do not use options — the expected text for
   * fill-in-the-blank, the JSON pairs for matching. The service decides which
   * of this and `options` is required, because that depends on the type and a
   * DTO cannot express "one or the other depending on a sibling field".
   */
  @IsOptional() @Transform(nullable) correct_answer?: string | null;

  /**
   * OPTIONAL at this layer, and required by the service for the
   * options-backed types only. It used to be mandatory with a minimum of two,
   * which is right for multiple choice and impossible for fill-in-the-blank.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OptionDto)
  options?: OptionDto[];
}

export class AnswerDto {
  @IsInt({ message: 'question_id must be an integer' })
  question_id!: number;

  @IsOptional() @IsInt() selected_option_id?: number | null;
}

export class SubmitAttemptDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnswerDto)
  answers!: AnswerDto[];
}
