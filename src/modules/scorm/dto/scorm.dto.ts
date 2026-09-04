import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class AssignScormDto {
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true, message: 'user_ids must contain integers' })
  user_ids?: number[];

  /** Assigns every active learner in the department when user_ids is empty. */
  @IsOptional() @IsString() department?: string;
}

export class UnassignScormDto {
  @IsInt({ message: 'user_id is required' })
  user_id!: number;
}

export class SaveTrackingDto {
  /** The full CMI object from scorm-again. Stored verbatim plus extracted fields. */
  @IsObject({ message: 'cmi_data is required' })
  @IsNotEmpty()
  cmi_data!: Record<string, unknown>;
}

/**
 * One SCORM data-model write, as reported by the runtime bridge.
 *
 * `element_value` is nullable because clearing an element is a legitimate
 * write and a sentinel empty string would be indistinguishable from a real
 * one. `MaxLength` is a boundary sanity bound, not a SCORM rule: SCORM 1.2
 * caps `suspend_data` at 4,096 characters and 2004 at 64,000, so 64 KB
 * accepts the largest legal value from either and rejects anything that could
 * only be an attempt to use the log as free storage.
 */
export class DatamodelDeltaDto {
  /**
   * Whitelisted rather than accepted freely. A legal element path is
   * dot-separated identifiers with numeric indices — `cmi.core.lesson_status`,
   * `cmi.interactions.0.learner_response`. Anything else is malformed or
   * hostile, and rejecting it at the boundary keeps the analytics reads (which
   * filter on element_key) from having to defend against junk keys.
   */
  @IsString()
  @IsNotEmpty({ message: 'element_key is required' })
  @MaxLength(255, { message: 'element_key must be at most 255 characters' })
  @Matches(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, {
    message: 'element_key must be a dotted SCORM data-model path',
  })
  element_key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(65536, { message: 'element_value must be at most 65536 characters' })
  element_value?: string | null;
}

/**
 * A batch of deltas from one commit / terminate / unload flush.
 *
 * `ArrayMaxSize` bounds the work a single request can ask for. A commit from a
 * busy package carries dozens of elements; 500 is generous for that and still
 * a single-statement insert, whereas an unbounded array would let one request
 * build an arbitrarily large SQL statement.
 */
export class TrackDatamodelDto {
  @IsArray()
  @ArrayMaxSize(500, { message: 'at most 500 deltas per request' })
  @ValidateNested({ each: true })
  @Type(() => DatamodelDeltaDto)
  deltas!: DatamodelDeltaDto[];
}

/**
 * Pagination for the data-model log reads.
 *
 * Defaults are supplied here rather than in the service so the contract is
 * visible in the DTO and `ValidationPipe`'s `transform` applies them — an
 * unbounded default on this table would be the §7.6 mistake, since a single
 * sitting can emit thousands of rows.
 */
export class ListDatamodelQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(500, { message: 'limit must be at most 500' })
  limit: number = 100;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset must be an integer' })
  @Min(0)
  offset: number = 0;
}
