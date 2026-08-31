import { Injectable } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import {
  POINTS_PER_LESSON,
  POINTS_PER_PASSED_ASSESSMENT,
} from '@/modules/leaderboard/points';
import { thisMonth } from '@/modules/learning-hours/periods';

import { LeaderboardRepository } from './leaderboard.repository';

export interface LeaderboardEntry {
  id: number;
  name: string;
  firstName: string;
  lastName: string;
  dept: string;
  points: number;
  monthPoints: number;
  /** Distinct assessments passed. */
  badges: number;
  attempts: number;
  avgScore: number | null;
  coursesMonth: number;
  /** Attempts spent per assessment passed. Lower is more efficient. */
  attemptsPerPass: number | null;
  rank: number;
  monthRank: number;
}

export interface Recognition {
  learnerOfMonth: { name: string; points: number; badges: number; id: number } | null;
  quickLearner: { name: string; coursesThisMonth: number; id: number } | null;
  assessmentTopper:
    | {
        name: string;
        id: number;
        avgScore: number | null;
        passed: number;
        attempts: number;
        attemptsPerPass: number;
      }
    | null;
}

/**
 * The single leaderboard calculation, read by both portals.
 *
 * The two boards used to rank on different things — learners on points, the
 * admin on a 60/40 blend of completion and hours — so a learner could be told
 * they were first while the admin board showed someone else on top. There is
 * one ordering now, and it is the one learners are shown competing on.
 */
@Injectable()
export class LeaderboardService {
  constructor(private readonly repository: LeaderboardRepository) {}

  async standings(scope: OrgScope, month: string = thisMonth()) {
    const rows = await this.repository.standings(scope, month);

    const entries: LeaderboardEntry[] = rows.map((row) => {
      const passed = Number(row.passed);
      const attempts = Number(row.attempts);
      return {
        id: Number(row.id),
        name: `${row.first_name} ${row.last_name}`,
        firstName: row.first_name,
        lastName: row.last_name,
        dept: row.department || 'Unknown',
        points:
          Number(row.lessons) * POINTS_PER_LESSON +
          passed * POINTS_PER_PASSED_ASSESSMENT,
        monthPoints:
          Number(row.lessons_month) * POINTS_PER_LESSON +
          Number(row.passed_month) * POINTS_PER_PASSED_ASSESSMENT,
        badges: passed,
        attempts,
        avgScore: row.avg_score !== null ? Math.round(Number(row.avg_score)) : null,
        coursesMonth: Number(row.courses_month),
        attemptsPerPass: passed > 0 ? attempts / passed : null,
        rank: 0,
        monthRank: 0,
      };
    });

    const byPoints = [...entries].sort(
      (a, b) => b.points - a.points || b.badges - a.badges,
    );
    byPoints.forEach((entry, index) => { entry.rank = index + 1; });

    const byMonth = [...entries].sort(
      (a, b) => b.monthPoints - a.monthPoints || b.badges - a.badges,
    );
    byMonth.forEach((entry, index) => { entry.monthRank = index + 1; });

    return { entries, byPoints, byMonth, recognition: this.recognise(entries, byMonth) };
  }

  /**
   * The three recognition cards.
   *
   * `assessmentTopper` is deliberately about EFFICIENCY, not raw score: the
   * learner who needed the fewest attempts per assessment passed. Someone who
   * passes four assessments first time (1.0) beats someone who passed the same
   * four after eleven tries (2.75). Ties break toward more assessments passed,
   * then the higher average — so a single lucky first-time pass does not
   * outrank a learner who did it repeatedly.
   */
  private recognise(
    entries: LeaderboardEntry[],
    byMonth: LeaderboardEntry[],
  ): Recognition {
    const monthLeader = byMonth.find((e) => e.monthPoints > 0) ?? null;

    const quickest =
      [...entries]
        .filter((e) => e.coursesMonth > 0)
        .sort((a, b) => b.coursesMonth - a.coursesMonth || b.monthPoints - a.monthPoints)[0] ??
      null;

    const topper =
      [...entries]
        .filter((e) => e.attemptsPerPass !== null)
        .sort(
          (a, b) =>
            (a.attemptsPerPass ?? Infinity) - (b.attemptsPerPass ?? Infinity) ||
            b.badges - a.badges ||
            (b.avgScore ?? 0) - (a.avgScore ?? 0),
        )[0] ?? null;

    return {
      learnerOfMonth: monthLeader
        ? {
            id: monthLeader.id,
            name: monthLeader.name,
            points: monthLeader.monthPoints,
            badges: monthLeader.badges,
          }
        : null,
      quickLearner: quickest
        ? { id: quickest.id, name: quickest.name, coursesThisMonth: quickest.coursesMonth }
        : null,
      assessmentTopper: topper
        ? {
            id: topper.id,
            name: topper.name,
            avgScore: topper.avgScore,
            passed: topper.badges,
            attempts: topper.attempts,
            attemptsPerPass: Math.round((topper.attemptsPerPass ?? 0) * 100) / 100,
          }
        : null,
    };
  }
}
