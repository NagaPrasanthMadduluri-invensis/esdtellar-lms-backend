import { Transform, Type } from 'class-transformer';
import { BATCH_STATUSES, ENROLL_MODES } from '@/common/session-enrolment';
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

  /**
   * `assigned` (an admin adds people) or `self` (learners enrol themselves,
   * and queue on the waitlist once it is full). Omitted keeps whatever the
   * session already had; a new session defaults to `assigned`.
   */
  @IsOptional()
  @IsIn(ENROLL_MODES, {
    message: `enroll_mode must be one of: ${ENROLL_MODES.join(', ')}`,
  })
  enroll_mode?: string;

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

/** Bulk action over a selection of sessions, from the list's action bar. */
export class BulkSessionsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'ids: select at least one session' })
  @Type(() => Number)
  @IsInt({ each: true, message: 'ids must be integers' })
  ids!: number[];

  @IsIn(['cancel', 'archive', 'restore', 'delete'], {
    message: 'action must be one of: cancel, archive, restore, delete',
  })
  action!: 'cancel' | 'archive' | 'restore' | 'delete';
}

/**
 * A batch — one sitting of a session.
 *
 * `date` may be null: a batch can be created before its date is fixed, which
 * is the derived `pending` state. `status` never carries `pending` for that
 * reason (`common/session-enrolment.ts`).
 */
export class SessionBatchDto {
  @IsOptional() @MaxLength(80) @Transform(nullable) label?: string | null;
  @IsOptional() @Transform(nullable) date?: string | null;
  @IsOptional() @Transform(nullable) start_time?: string | null;
  @IsOptional() @Transform(nullable) end_time?: string | null;

  /** Null falls back to the session's own capacity. */
  @IsOptional() @IsInt() @Min(1) capacity?: number | null;
  @IsOptional() @IsInt() trainer_user_id?: number | null;

  @IsOptional()
  @IsIn(BATCH_STATUSES, {
    message: `status must be one of: ${BATCH_STATUSES.join(', ')}`,
  })
  status?: string;
}

/** Move one rostered learner between sittings. `batch_id: null` unassigns. */
export class MoveToBatchDto {
  @IsInt({ message: 'user_id must be an integer' })
  user_id!: number;

  @IsOptional() @IsInt() batch_id?: number | null;
}
