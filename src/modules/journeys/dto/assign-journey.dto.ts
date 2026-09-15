import { Transform, Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, MinLength } from 'class-validator';

const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Exactly one of `user_ids` / `department` is expected — enforced in
 * `JourneysService.assign`, not here, because "at least one of two optional
 * fields" is a cross-field rule `class-validator`'s decorators do not express
 * cleanly, and the 422 message is clearer written out by hand.
 */
export class AssignJourneyDto {
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true, message: 'user_ids must contain integers' })
  user_ids?: number[];

  /** Assigns every active learner in the department when user_ids is absent. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  department?: string;

  @IsOptional()
  @Transform(nullable)
  due_date?: string | null;
}
