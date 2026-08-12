import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
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
