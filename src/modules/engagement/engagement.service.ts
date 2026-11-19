import { Injectable } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import {
  LearningHoursService,
  type Granularity,
} from '@/modules/learning-hours/learning-hours.service';

import { EngagementRepository } from './engagement.repository';

const TRUNC_FOR: Record<Granularity, string> = {
  weekly: 'week',
  monthly: 'month',
  quarterly: 'quarter',
  yearly: 'year',
};

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const round1 = (n: number) => Math.round(n * 10) / 10;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function labelFor(iso: string, granularity: Granularity): string {
  const [y, m, d] = iso.split('-').map(Number);
  const yy = String(y).slice(2);
  if (granularity === 'weekly') return `${d} ${MONTHS[(m || 1) - 1]}`;
  if (granularity === 'monthly') return `${MONTHS[(m || 1) - 1]} '${yy}`;
  if (granularity === 'quarterly') return `Q${Math.floor(((m || 1) - 1) / 3) + 1} ${y}`;
  return `${y}`;
}

export interface TrendPoint {
  period: string;
  label: string;
  learningHours: number;
  engagementHours: number;
}

export interface EngagementTrend {
  granularity: Granularity;
  series: TrendPoint[];
  totals: { learningHours: number; engagementHours: number };
}

/**
 * Engagement (active time) tracking, and its comparison against §10.4 learning
 * hours (owner request 2026-11-19). Learning hours are REUSED from
 * `LearningHoursService` so the comparison can never disagree with the Learning
 * Hours page; engagement is this module's own metric. They measure different
 * things on purpose: engagement is time present and active, learning hours is
 * time that produced course progress/completion.
 */
@Injectable()
export class EngagementService {
  constructor(
    private readonly repository: EngagementRepository,
    private readonly hours: LearningHoursService,
  ) {}

  /** Record a batch of active seconds for the caller (best-effort telemetry). */
  async ping(scope: OrgScope, userId: number, seconds: number): Promise<void> {
    await this.repository.addSeconds(scope, userId, seconds);
  }

  /**
   * One learner's engagement-vs-learning trend. The axis and the learning series
   * come from `learnerHoursTrend` (its labels and buckets), and engagement is
   * overlaid by the same period key — so both lines share identical periods.
   */
  async learnerTrend(
    scope: OrgScope,
    userId: number,
    granularity: Granularity,
  ): Promise<EngagementTrend> {
    const unit = TRUNC_FOR[granularity];
    const [trend, eng] = await Promise.all([
      this.hours.learnerHoursTrend(scope, userId),
      this.repository.learnerByPeriod(scope, userId, unit),
    ]);
    const engMap = new Map(eng.map((r) => [r.period, Number(r.seconds)]));
    const series: TrendPoint[] = trend[granularity].map((p) => ({
      period: p.period,
      label: p.label,
      learningHours: round1(p.total / 60),
      engagementHours: round1((engMap.get(p.period) ?? 0) / 3600),
    }));
    return { granularity, series, totals: totalsOf(series) };
  }

  /** The organisation's engagement-vs-learning trend, periods unioned from both. */
  async orgTrend(
    scope: OrgScope,
    granularity: Granularity,
  ): Promise<EngagementTrend> {
    const unit = TRUNC_FOR[granularity];
    const [learningRows, engRows] = await Promise.all([
      this.hours.minutesByPeriod(scope, unit as never),
      this.repository.orgByPeriod(scope, unit),
    ]);
    const learnMap = new Map(
      learningRows.map((r: { period: unknown; minutes: unknown }) => [
        toIso(r.period),
        Number(r.minutes),
      ]),
    );
    const engMap = new Map(engRows.map((r) => [r.period, Number(r.seconds)]));
    const periods = [...new Set([...learnMap.keys(), ...engMap.keys()])].sort();
    const series: TrendPoint[] = periods.map((period) => ({
      period,
      label: labelFor(period, granularity),
      learningHours: round1((learnMap.get(period) ?? 0) / 60),
      engagementHours: round1((engMap.get(period) ?? 0) / 3600),
    }));
    return { granularity, series, totals: totalsOf(series) };
  }
}

function totalsOf(series: TrendPoint[]): {
  learningHours: number;
  engagementHours: number;
} {
  return {
    learningHours: round1(series.reduce((a, p) => a + p.learningHours, 0)),
    engagementHours: round1(series.reduce((a, p) => a + p.engagementHours, 0)),
  };
}
