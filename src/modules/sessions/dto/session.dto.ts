import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
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

export class SessionDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional() @IsIn(['ILT', 'Virtual']) session_type?: 'ILT' | 'Virtual';
  @IsOptional() @Transform(nullable) department?: string | null;
  @IsOptional() @IsInt() course_id?: number | null;
  @IsOptional() @IsInt() capacity?: number;

  @IsString()
  @MinLength(1, { message: 'trainer is required' })
  @Transform(trim)
  trainer!: string;

  @IsString()
  @MinLength(1, { message: 'venue_url is required' })
  @Transform(trim)
  venue_url!: string;

  @IsString()
  @MinLength(1, { message: 'date is required' })
  @Transform(trim)
  date!: string;

  @IsString()
  @MinLength(1, { message: 'start_time is required' })
  @Transform(trim)
  start_time!: string;

  @IsString()
  @MinLength(1, { message: 'end_time is required' })
  @Transform(trim)
  end_time!: string;

  @IsOptional() @Transform(nullable) description?: string | null;
  @IsOptional()
  @IsIn(['upcoming', 'completed', 'cancelled'])
  status?: 'upcoming' | 'completed' | 'cancelled';
}

/** Either a single `user_id`, or `enroll_all` + `department` for a bulk add. */
export class RosterAddDto {
  @IsOptional() @IsInt() user_id?: number;
  @IsOptional() @IsBoolean() enroll_all?: boolean;
  @IsOptional() @IsString() department?: string;
}

export class RosterRemoveDto {
  @IsInt({ message: 'user_id is required' })
  user_id!: number;
}

export class AttendanceRecordDto {
  @IsInt({ message: 'user_id must be an integer' })
  user_id!: number;

  @IsOptional() @IsString() status?: string | null;
  @IsOptional() @IsString() join_time?: string | null;
  @IsOptional() @IsString() notes?: string | null;
}

export class SaveAttendanceDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttendanceRecordDto)
  records?: AttendanceRecordDto[];

  /** `true` finalises the record — the UI refuses further edits afterwards. */
  @IsOptional() @IsBoolean() lock?: boolean;
}
