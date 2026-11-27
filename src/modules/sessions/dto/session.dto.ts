import { Transform, Type } from 'class-transformer';
import { BATCH_STATUSES, ENROLL_MODES } from '@/common/session-enrolment';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One time slot on the create form; becomes one batch on every date (0076). */
export class SessionSlotDto {
  @IsOptional() @MaxLength(80) @Transform(nullable) label?: string | null;
  @IsOptional() @Transform(nullable) @Matches(/^\d{1,2}:\d{2}$/, { message: 'start_time must be HH:MM' }) start_time?: string | null;
  @IsOptional() @Transform(nullable) @Matches(/^\d{1,2}:\d{2}$/, { message: 'end_time must be HH:MM' }) end_time?: string | null;
  @IsOptional() @IsInt() @Min(1) capacity?: number | null;
  @IsOptional() @IsInt() trainer_user_id?: number | null;
}

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

  @IsOptional() @IsIn(['ILT', 'Virtual', 'Webinar']) session_type?: 'ILT' | 'Virtual' | 'Webinar';

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

  /**
   * Last day of a multi-day sitting, inclusive (0074). Omitted or null is a
   * one-day session. Must not be before `date` (checked in the service).
   */
  @IsOptional()
  @Transform(nullable)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'end_date must be YYYY-MM-DD' })
  end_date?: string | null;

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

  /**
   * Every date the session runs on (0076). Overrides `date` to `end_date`
   * when given. On an edit, a date taken away and one put in are paired as a
   * move (postponed or preponed), keeping its batches.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(62, { message: 'A session can have at most 62 dates' })
  @Matches(ISO_DATE, { each: true, message: 'dates must be YYYY-MM-DD' })
  dates?: string[];

  /** Create only: time slots, each becoming a batch on every date (0076). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12, { message: 'At most 12 time slots' })
  @ValidateNested({ each: true })
  @Type(() => SessionSlotDto)
  slots?: SessionSlotDto[];
}

/** PUT :sessionId/schedule — the full set of dates wanted (0076). */
export class ScheduleDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'A session needs at least one date' })
  @ArrayMaxSize(62, { message: 'A session can have at most 62 dates' })
  @Matches(ISO_DATE, { each: true, message: 'dates must be YYYY-MM-DD' })
  dates!: string[];
}

/** POST :sessionId/dates and PUT dates/:dateId (0076). */
export class SessionDateDto {
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD' })
  date!: string;
}

/** Either a single `user_id`, or `enroll_all` + `department` for a bulk add. */
export class RosterAddDto {
  @IsOptional() @IsInt() user_id?: number;
  /** Place a single learner straight into this batch; refused when it is full. */
  @IsOptional() @IsInt() batch_id?: number | null;
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

  /** The date being marked (0076). Omitted = every date of the session. */
  @IsOptional() @IsInt() session_date_id?: number;
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
  /** The date the new batch runs on (0076). Or give `date`. */
  @IsOptional() @IsInt() session_date_id?: number;
  @IsOptional() @MaxLength(80) @Transform(nullable) label?: string | null;
  @IsOptional() @Transform(nullable) date?: string | null;
  /** Last day of a multi-day batch, inclusive (0074). Null = one day. */
  @IsOptional()
  @Transform(nullable)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'end_date must be YYYY-MM-DD' })
  end_date?: string | null;
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

  /** With `batch_id: null`, the date to take them off (0076). */
  @IsOptional() @IsInt() session_date_id?: number;
}

/** A learner booking a place: one batch per date that offers a choice (0076). */
export class SelfEnrolDto {
  @IsOptional() @IsInt({ message: 'batch_id must be an integer' }) batch_id?: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true, message: 'batch_ids must be integers' })
  batch_ids?: number[];
}
