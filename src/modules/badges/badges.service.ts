import { Injectable, Logger } from '@nestjs/common';

import {
  BADGE_CATALOGUE,
  BADGES,
  isJourneyBadgeKey,
  type BadgeDescriptor,
  type BadgeId,
  type BadgeMetric,
} from '@/common/badges';
import type { OrgScope } from '@/database/org-scope';
import { LeaderboardService } from '@/modules/leaderboard/leaderboard.service';

import { badgeHint } from './badge-hint.util';
import { BadgesRepository } from './badges.repository';

/** Every number a catalogue badge's `metric` can be compared against. */
export type BadgeStatsValues = Record<BadgeMetric, number>;

export interface BadgeListEntry {
  id: string;
  label: string;
  description: string | null;
  tier: string | null;
  icon: string;
  earned: boolean;
  earnedAt: string | null;
}

export interface BadgeListResult {
  badges: BadgeListEntry[];
  next: (BadgeListEntry & { hint: string }) | null;
}

@Injectable()
export class BadgesService {
  private readonly logger = new Logger(BadgesService.name);

  constructor(
    private readonly repository: BadgesRepository,
    private readonly leaderboard: LeaderboardService,
  ) {}

  /**
   * Awards a single badge — the shape a per-journey badge (`journey:<id>`)
   * needs, since it is not in the catalogue and its `journeyId` has to be
   * recorded for the label/icon join. Idempotent: `ON CONFLICT DO NOTHING`.
   * Returns whether this call actually awarded it (false on a replay).
   */
  async award(
    scope: OrgScope,
    userId: number,
    badgeKey: string,
    journeyId?: number,
  ): Promise<boolean> {
    return this.repository.award(scope, userId, badgeKey, journeyId ?? null);
  }

  /**
   * Every stat a catalogue badge is measured against, `points` taken from the
   * ONE leaderboard calculation (`LeaderboardService.standings()`,
   * BACKEND_STRUCTURE.md §10.5) rather than re-derived here — a second
   * formula could drift from what the board actually pays. Pass `knownPoints`
   * when the caller already has this learner's standing (achievements() does)
   * to skip the extra bulk query.
   */
  async getStats(
    scope: OrgScope,
    userId: number,
    knownPoints?: number,
  ): Promise<BadgeStatsValues> {
    const [row, points] = await Promise.all([
      this.repository.getStats(scope, userId),
      knownPoints !== undefined ? Promise.resolve(knownPoints) : this.pointsFor(scope, userId),
    ]);

    return {
      completedCourses: Number(row.completed_courses),
      completedBeforeDue: Number(row.completed_before_due),
      maxAssessmentScore: Number(row.max_assessment_score),
      // No feedback table exists yet — carried over unchanged from the
      // derive-on-read code, which also always read 0 here.
      feedbackCount: 0,
      points,
      journeysCompleted: Number(row.journeys_completed),
    };
  }

  private async pointsFor(scope: OrgScope, userId: number): Promise<number> {
    const standings = await this.leaderboard.standings(scope);
    return standings.entries.find((e) => e.id === userId)?.points ?? 0;
  }

  /**
   * Re-evaluates every catalogue badge from the learner's current stats and
   * persists any newly-earned one in ONE set-based insert — never a query per
   * badge. Idempotent by construction (`awardMany`'s `ON CONFLICT DO NOTHING`),
   * so replaying this on every trigger is exactly the point: a badge earned
   * once stays earned even if the underlying data later changes, and a badge
   * not yet earned is granted the moment its threshold is crossed.
   */
  async syncFor(
    scope: OrgScope,
    userId: number,
    knownPoints?: number,
  ): Promise<{ stats: BadgeStatsValues; awarded: BadgeId[] }> {
    const stats = await this.getStats(scope, userId, knownPoints);
    const eligible = BADGE_CATALOGUE.filter((b) => stats[b.metric] >= b.threshold).map(
      (b) => b.id,
    );
    const awarded =
      eligible.length > 0 ? await this.repository.awardMany(scope, userId, eligible) : [];

    return { stats, awarded: awarded as BadgeId[] };
  }

  /**
   * Best-effort variant for a completion trigger (§8.4): a badge sync failure
   * must never break marking a lesson complete, submitting an assessment or a
   * SCORM commit.
   */
  async syncForBestEffort(scope: OrgScope, userId: number, knownPoints?: number): Promise<void> {
    try {
      await this.syncFor(scope, userId, knownPoints);
    } catch (error) {
      this.logger.warn(
        `Badge sync skipped for user=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Every badge_key this learner already holds, catalogue and per-journey alike. */
  async earnedKeys(scope: OrgScope, userId: number): Promise<Set<string>> {
    const rows = await this.repository.listEarned(scope, userId);
    return new Set(rows.map((r) => r.badge_key));
  }

  /**
   * `GET /learner/badges` — every catalogue badge (earned or not) plus every
   * per-journey badge actually earned, and a hint toward the next unearned
   * catalogue one.
   */
  async listForLearner(scope: OrgScope, userId: number): Promise<BadgeListResult> {
    const { stats } = await this.syncFor(scope, userId);
    const earnedRows = await this.repository.listEarned(scope, userId);
    const earnedByKey = new Map(earnedRows.map((r) => [r.badge_key, r]));

    const catalogueBadges: BadgeListEntry[] = BADGE_CATALOGUE.map((def) => {
      const row = earnedByKey.get(def.id);
      return {
        id: def.id,
        label: def.label,
        description: def.description,
        tier: def.tier,
        icon: def.icon,
        earned: row !== undefined,
        earnedAt: row?.earned_at ?? null,
      };
    });

    const journeyBadges: BadgeListEntry[] = earnedRows
      .filter((r) => isJourneyBadgeKey(r.badge_key))
      .map((r) => ({
        id: r.badge_key,
        label: r.journey_badge_label ?? 'Journey complete',
        description: r.journey_title ? `Completed the ${r.journey_title} journey` : null,
        tier: null,
        icon: r.journey_badge_icon ?? 'award',
        earned: true,
        earnedAt: r.earned_at,
      }));

    const nextDef: BadgeDescriptor | undefined = BADGE_CATALOGUE.find(
      (def) => !earnedByKey.has(def.id),
    );
    const next = nextDef
      ? {
          id: nextDef.id,
          label: nextDef.label,
          description: nextDef.description,
          tier: nextDef.tier,
          icon: nextDef.icon,
          earned: false,
          earnedAt: null,
          hint: badgeHint(BADGES[nextDef.id], stats[nextDef.metric]),
        }
      : null;

    return { badges: [...catalogueBadges, ...journeyBadges], next };
  }
}
