import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const PROGRESS = ['completed', 'failed', 'in-progress', 'not-started'] as const;
const STATUS = ['active', 'inactive'] as const;

/**
 * The query behind the Manage Users table, which is now paginated server-side
 * (§7.6 — the directory was unbounded). Every field is optional: with none of
 * them the first page of the whole organization comes back.
 *
 * `search` and the filters narrow the MATCHED set the page is drawn from and
 * the `total` counted against it; they do NOT narrow the KPI tiles, which stay
 * an org-wide summary (`UsersService.directory`). `role` is the RBAC role
 * LABEL (Admin, Manager, Learner, Trainer), because that is what the column
 * shows — `users.role` collapses a Manager into 'learner'.
 */
export class ListDirectoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'offset must be an integer' })
  @Min(0)
  offset?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsIn(STATUS, { message: 'status must be active or inactive' })
  status?: (typeof STATUS)[number];

  @IsOptional()
  @IsIn(PROGRESS, { message: 'progress is not a known value' })
  progress?: (typeof PROGRESS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  department?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  job_role?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  job_level?: string;

  /** The RBAC role LABEL — Admin, Manager, Learner, Trainer. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  role?: string;
}
