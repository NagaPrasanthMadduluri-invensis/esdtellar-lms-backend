import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

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

  @IsOptional() @Transform(nullable) description?: string | null;
  @IsOptional() @IsInt() passing_score?: number;
  @IsOptional() @IsBoolean() is_active?: boolean;
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

  @IsArray()
  @ArrayMinSize(2, { message: 'options must contain at least 2 options' })
  @ValidateNested({ each: true })
  @Type(() => OptionDto)
  options!: OptionDto[];
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
