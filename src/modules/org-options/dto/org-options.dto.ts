import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class BranchLocationDto {
  @IsString() @MinLength(1, { message: 'a branch location needs a name' })
  @MaxLength(120) @Transform(trim)
  name!: string;

  @IsOptional() @IsString() @MaxLength(4) @Transform(trim)
  country_code?: string | null;

  @IsOptional() @IsString() @MaxLength(80) @Transform(trim)
  country_name?: string | null;

  @IsOptional() @IsString() @MaxLength(80) @Transform(trim)
  state_name?: string | null;
}

/**
 * The whole set, not a diff. See `replaceLocations` for why removal is a
 * deactivation rather than a delete.
 *
 * Capped at 200: a dropdown longer than that is not a dropdown, and the cap
 * is what stops a paste of every city in a country becoming one tenant's
 * branch list.
 */
export class SetLocationsDto {
  @IsArray() @ArrayMaxSize(200, { message: 'at most 200 branch locations' })
  @ValidateNested({ each: true })
  @Type(() => BranchLocationDto)
  locations!: BranchLocationDto[];
}

export class SetJobLevelsDto {
  @IsArray() @ArrayMaxSize(40, { message: 'at most 40 job levels' })
  @IsString({ each: true })
  job_levels!: string[];
}
