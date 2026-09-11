import { Transform, Type } from 'class-transformer';
import {
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

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Like `nullable`, but keeps an absent value absent — so "the admin did not
 * touch the picture" can be told apart from "the admin removed it" (§10.10).
 */
const keepUndefined = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  return nullable({ value });
};

export class SessionDto {
  @IsString()
  @MinLength(1, { message: 'title is required' })
  @Transform(trim)
  title!: string;

  @IsOptional() @IsIn(['ILT', 'Virtual']) session_type?: 'ILT' | 'Virtual';

  /**
   * The session's cover picture, stored on its companion training course —
   * which IS the card the learner sees (§10.7), so there is no second column
   * and nothing new to render.
   *
   * Absent leaves it alone, null removes it, a string sets it. Every other
   * field here is rewritten from the form on every save; this one must not be,
   * or editing the venue would delete the picture.
   */
  @IsOptional() @Transform(keepUndefined) thumbnail_url?: string | null;
  @IsOptional() @Transform(nullable) department?: string | null;
  @IsOptional() @IsInt() course_id?: number | null;
  @IsOptional() @IsInt() capacity?: number;

  /**
   * The display name. Still required, and still free text, so a session can
   * name an external facilitator who has no account. When `trainer_user_id`
   * is also given, the server OVERWRITES this with that user's name — the two
   * must not be able to disagree (`specs/rbac.md` §3.6.1).
   */
  @IsString()
  @MinLength(1, { message: 'trainer is required' })
  @Transform(trim)
  trainer!: string;

  /**
   * Optional link to a trainer account. Setting it is what puts the session in
   * that trainer's portal; leaving it null keeps the session admin-only, which
   * is the existing behaviour and the only option for an org with no trainer
   * accounts yet.
   */
  @IsOptional() @IsInt() trainer_user_id?: number | null;

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

  @IsOptional()
  @MaxLength(DESCRIPTION_MAX_LENGTH, { message: DESCRIPTION_TOO_LONG })
  @Transform(nullable)
  description?: string | null;
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
