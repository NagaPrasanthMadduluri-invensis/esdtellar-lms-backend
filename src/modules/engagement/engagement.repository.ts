import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

export interface PeriodSecondsRow {
  period: string; // bucket start, YYYY-MM-DD
  seconds: number;
}

/** A day holds 86,400 seconds — the ceiling an accumulator can ever reach. */
const DAY_SECONDS = 86_400;

/** date_trunc units allowed from the period selector (never raw caller input). */
const TRUNC = new Set(['week', 'month', 'quarter', 'year']);
function assertTrunc(unit: string): string {
  if (!TRUNC.has(unit)) throw new Error(`engagement: bad trunc "${unit}"`);
  return unit;
}

@Injectable()
export class EngagementRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Add a batch of active seconds to today's accumulator for this learner, in
   * their own org. Capped at a day so a broken or hostile client cannot inflate
   * the figure past what a day physically holds.
   */
  async addSeconds(scope: OrgScope, userId: number, seconds: number): Promise<void> {
    await this.db.run(sql`
      INSERT INTO engagement_daily (organization_id, user_id, day, active_seconds, updated_at)
      VALUES (${scope.organizationId}, ${userId}, CURRENT_DATE, LEAST(${seconds}::int, ${DAY_SECONDS}::int), now())
      ON CONFLICT (user_id, day) DO UPDATE SET
        active_seconds = LEAST(engagement_daily.active_seconds + EXCLUDED.active_seconds, ${DAY_SECONDS}::int),
        updated_at = now()
    `);
  }

  /** One learner's engaged seconds per period. */
  async learnerByPeriod(
    scope: OrgScope,
    userId: number,
    unit: string,
  ): Promise<PeriodSecondsRow[]> {
    const trunc = assertTrunc(unit);
    return this.db.all<PeriodSecondsRow>(sql`
      SELECT to_char(date_trunc(${trunc}, ed.day), 'YYYY-MM-DD') AS period,
             SUM(ed.active_seconds)::int AS seconds
      FROM engagement_daily ed
      WHERE ${orgScope('ed', scope)} AND ed.user_id = ${userId}
      GROUP BY 1
    `);
  }

  /** The whole org's engaged seconds per period. */
  async orgByPeriod(scope: OrgScope, unit: string): Promise<PeriodSecondsRow[]> {
    const trunc = assertTrunc(unit);
    return this.db.all<PeriodSecondsRow>(sql`
      SELECT to_char(date_trunc(${trunc}, ed.day), 'YYYY-MM-DD') AS period,
             SUM(ed.active_seconds)::int AS seconds
      FROM engagement_daily ed
      WHERE ${orgScope('ed', scope)}
      GROUP BY 1
    `);
  }
}
