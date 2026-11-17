import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  INCIDENT_ASSESSMENTS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
} from '@/common/incidents';

/** Trim; an empty string means "clear it" (null). Undefined stays undefined. */
const nullable = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t.length ? t : null;
};

const TEXT_MAX = 4000;

/** Fields shared by create and update. All optional on update. */
class IncidentFieldsDto {
  @IsOptional() @IsString() @MaxLength(TEXT_MAX) @Transform(nullable)
  description?: string | null;

  @IsOptional() @IsIn(INCIDENT_SEVERITIES)
  severity?: string;

  @IsOptional() @IsString() @MaxLength(1000) @Transform(nullable)
  data_categories?: string | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  individuals_affected?: number | null;

  @IsOptional() @IsString() @MaxLength(TEXT_MAX) @Transform(nullable)
  cause?: string | null;

  @IsOptional() @IsString() @MaxLength(TEXT_MAX) @Transform(nullable)
  containment?: string | null;

  /** Affected client organizations; replaces the set when present. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsInt({ each: true })
  organization_ids?: number[];
}

export class CreateIncidentDto extends IncidentFieldsDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  title!: string;

  /** When it was discovered. Defaults to now: the clocks start at awareness. */
  @IsOptional() @IsDateString()
  discovered_at?: string;
}

export class UpdateIncidentDto extends IncidentFieldsDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  title?: string;

  @IsOptional() @IsDateString()
  discovered_at?: string;

  @IsOptional() @IsIn(INCIDENT_STATUSES)
  status?: string;

  @IsOptional() @IsIn(INCIDENT_ASSESSMENTS)
  assessment?: string;

  /** When the assessment was made; defaults to now when the outcome changes. */
  @IsOptional() @IsDateString()
  assessed_at?: string;

  /** Stamps recorded by hand (a regulator filing happens outside the app). Null clears. */
  @IsOptional() @IsDateString()
  regulator_notified_at?: string | null;

  @IsOptional() @IsString() @MaxLength(200) @Transform(nullable)
  regulator_reference?: string | null;

  @IsOptional() @IsDateString()
  individuals_notified_at?: string | null;
}

export class IncidentNoteDto {
  @IsString() @IsNotEmpty() @MaxLength(TEXT_MAX)
  note!: string;
}

export class NotifyClientsDto {
  /** What the client admins are told, in Edstellar's words. */
  @IsString() @IsNotEmpty() @MaxLength(TEXT_MAX)
  message!: string;
}
