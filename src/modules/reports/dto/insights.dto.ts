import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';


import {
  COMPARISON_DIMENSIONS,
  COMPARISON_METRICS,
  REPORT_TYPES,
} from '../insights.service';
import { GRANULARITIES, REPORT_WINDOWS } from '../periods.util';

const TYPE_KEYS = REPORT_TYPES.map((t) => t.key);
const WINDOW_KEYS = REPORT_WINDOWS.map((w) => w.key);
const DIMENSION_KEYS = COMPARISON_DIMENSIONS.map((d) => d.key);
const METRIC_KEYS = COMPARISON_METRICS.map((m) => m.key);

/** Empty string from a `<select>` with no choice made means "no filter". */
const nullable = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** `a,b,c` from a query string, or an array from a JSON body. */
const list = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

export class AnalyticsQueryDto {
  @IsOptional()
  @IsIn(GRANULARITIES, {
    message: `granularity must be one of: ${GRANULARITIES.join(', ')}`,
  })
  granularity?: string;
}

/**
 * The audience filters, shared by every report scope.
 *
 * `location` and `job_level` validate against the closed lists and the other
 * two do not: `location` and `job_level` come from the organization's curated
 * lists, `department` and `job_role` are free text whose values come from
 * whatever is in the table.
 *
 * **None of the four is `@IsIn`-validated any more, and that is correct for a
 * FILTER.** The two curated lists became per-organization tables in `0031`, so
 * the valid set is a query and a decorator cannot do queries. The check was
 * not moved to the service either, because a filter is not a write: an
 * unrecognised value matches no rows and returns an empty report, which is a
 * true answer. Compare `UpdateProfileDto`, where the same two fields DO get a
 * service-side check — writing a value nothing can filter on is the failure
 * §10.12 records, and reading one is not.
 */
export class ReportFilterDto {
  @IsOptional() @Transform(nullable) @IsString() @MaxLength(120)
  department?: string | null;

  @IsOptional() @Transform(nullable) @IsString() @MaxLength(120)
  location?: string | null;

  @IsOptional() @Transform(nullable) @IsString() @MaxLength(120)
  job_role?: string | null;

  @IsOptional() @Transform(nullable) @IsString() @MaxLength(120)
  job_level?: string | null;
}

export class GroupReportDto extends ReportFilterDto {
  /**
   * At least one type, at most all of them. An empty selection is rejected
   * rather than defaulted: "Create report" with nothing ticked is a mistake
   * the admin should see, not a silent Course Completion.
   */
  @Transform(list)
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one report' })
  @ArrayMaxSize(TYPE_KEYS.length)
  @IsIn(TYPE_KEYS, { each: true, message: `types must be from: ${TYPE_KEYS.join(', ')}` })
  types!: string[];

  @IsOptional()
  @IsIn(WINDOW_KEYS, { message: `window must be one of: ${WINDOW_KEYS.join(', ')}` })
  window?: string;
}

export class IndividualReportDto {
  @Type(() => Number)
  @IsInt({ message: 'user_id must be an integer' })
  @Min(1)
  user_id!: number;

  @IsOptional()
  @IsIn(WINDOW_KEYS, { message: `window must be one of: ${WINDOW_KEYS.join(', ')}` })
  window?: string;
}

export class ComparisonReportDto {
  @IsIn(DIMENSION_KEYS, { message: `dimension must be one of: ${DIMENSION_KEYS.join(', ')}` })
  dimension!: string;

  /**
   * Capped at twelve. Beyond that the comparison chart is unreadable and the
   * query fans out over every learner in each item — the cap is a legibility
   * rule first and a cost rule second.
   */
  @Transform(list)
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one item to compare' })
  @ArrayMaxSize(12, { message: 'Compare at most 12 items at once' })
  @IsString({ each: true })
  items!: string[];

  @Transform(list)
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one metric' })
  @ArrayMaxSize(METRIC_KEYS.length)
  @IsIn(METRIC_KEYS, { each: true, message: `metrics must be from: ${METRIC_KEYS.join(', ')}` })
  metrics!: string[];

  @IsOptional()
  @IsIn(WINDOW_KEYS, { message: `window must be one of: ${WINDOW_KEYS.join(', ')}` })
  window?: string;
}

export class ActivityQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;
}
