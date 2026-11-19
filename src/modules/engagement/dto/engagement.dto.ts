import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { GRANULARITIES } from '@/modules/learning-hours/learning-hours.service';

export class EngagementPingDto {
  /** Active seconds in this batch. Capped so one ping can never claim more than
   *  a few minutes; the server also caps the daily total. */
  @IsInt()
  @Min(1)
  @Max(600)
  seconds!: number;
}

export class EngagementTrendQueryDto {
  @IsOptional()
  @IsIn(GRANULARITIES as unknown as string[])
  granularity?: string;
}
