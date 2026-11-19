import { Injectable, Logger } from '@nestjs/common';

import { COMPETENCY_LEVELS, levelRank } from '@/common/competencies';
import type { OrgScope } from '@/database/org-scope';
import { AiInsightsService } from '@/modules/ai/ai-insights.service';
import { BadgesService } from '@/modules/badges/badges.service';
import { CompetenciesService } from '@/modules/competencies/competencies.service';
import { LeaderboardService } from '@/modules/leaderboard/leaderboard.service';
import { LearnerService } from '@/modules/learner/learner.service';
import { SurveysService } from '@/modules/surveys/surveys.service';

import { LearnerInsightsRepository } from './learner-insights.repository';
import {
  LEARNER_INSIGHTS_KIND,
  LEARNER_INSIGHTS_SCHEMA,
  LEARNER_INSIGHTS_SYSTEM,
  type LearnerInsightsPayload,
} from './learner-insights.prompt';

/**
 * The anonymised context sent to the model. This is the PII SURFACE for the AI
 * (spec §7): it must be reviewed before the feature is enabled in production.
 * It carries aggregates, content titles and the learner's professional
 * attributes, keyed to an opaque id — never a name, email, message or free-text.
 */
export interface LearnerFeatureContext {
  /** The single org this context was built for — asserted at the generation
   *  chokepoint (ai-tenant.ts) so a mis-scoped context can never reach a prompt. */
  organizationId: number;
  learner: {
    id: number;
    jobRole: string | null;
    jobLevel: string | null;
  };
  engagement: {
    assigned: number;
    completed: number;
    inProgress: number;
    notStarted: number;
    overdue: number;
    failedAssessments: number;
    certificatesEarned: number;
    points: number | null;
    monthPoints: number | null;
    completionPct: number | null;
    rankLabel: string | null;
  };
  inProgress: {
    name: string;
    category: string | null;
    pct: number;
    dueInDays: number | null;
    pointsOnCompletion: number | null;
  }[];
  overdue: { name: string; daysOverdue: number }[];
  pendingFeedback: { count: number; courses: string[] };
  pendingAssessments: string[];
  recommendable: { name: string; category: string | null; skills: string[] }[];
  competencies: { gained: { skill: string; level: string }[]; gaps: string[] };
  nearestBadge: { label: string; description: string | null; hint: string | null } | null;
}

const DAY_MS = 86_400_000;

/** Cap a user-authored string before it enters the prompt, so an over-long or
 *  crafted value cannot flood or steer the model (prompt-injection defence). */
function clip(value: string, max = 160): string {
  return value.length > max ? value.slice(0, max) : value;
}

function dayDiffFromNow(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / DAY_MS);
}

@Injectable()
export class LearnerInsightsService {
  private readonly logger = new Logger('LearnerInsights');

  constructor(
    private readonly ai: AiInsightsService,
    private readonly repository: LearnerInsightsRepository,
    private readonly learner: LearnerService,
    private readonly leaderboard: LeaderboardService,
    private readonly badges: BadgesService,
    private readonly competencies: CompetenciesService,
    private readonly surveys: SurveysService,
  ) {}

  /**
   * Build the anonymised feature context. Every number comes from the canonical
   * service that owns its definition (§10.4/§10.5/§10.11) — this only selects
   * and reshapes, so a learner's AI context can never disagree with the screens
   * that show the same figures.
   */
  async buildContext(
    scope: OrgScope,
    userId: number,
  ): Promise<LearnerFeatureContext> {
    const [profile, coursesData, standings, badgeList, comps, pendingFb, recommendable] =
      await Promise.all([
        this.repository.learnerProfile(scope, userId),
        this.learner.courses(scope, userId),
        this.leaderboard.standings(scope),
        this.badges.listForLearner(scope, userId),
        this.competencies.listMyCompetencies(scope, userId),
        this.surveys.pendingForLearner(scope, userId),
        this.repository.recommendableCourses(scope, userId, 20),
      ]);

    const courses = coursesData.courses;
    const entry = standings.entries.find((e) => e.id === userId) ?? null;
    const ranked = standings.ranked.find((e) => e.id === userId) ?? null;
    const rankLabel =
      standings.settings.enabled && ranked && ranked.rank >= 1
        ? `#${ranked.rank} of ${standings.ranked.length}`
        : null;

    const inProgress = courses
      .filter((c) => c.status === 'in-progress')
      .slice(0, 8)
      .map((c) => ({
        name: clip(c.course.name),
        category: c.category ?? null,
        pct: c.progressPct,
        dueInDays: dayDiffFromNow(c.dueDate),
        pointsOnCompletion: c.reward?.totalPoints ?? null,
      }));

    const overdue = courses
      .filter((c) => {
        if (c.status === 'completed') return false;
        const d = dayDiffFromNow(c.dueDate);
        return d !== null && d < 0;
      })
      .slice(0, 8)
      .map((c) => ({
        name: clip(c.course.name),
        daysOverdue: Math.abs(dayDiffFromNow(c.dueDate) ?? 0),
      }));

    const pendingAssessments = courses
      .filter((c) => c.hasFailed)
      .slice(0, 8)
      .map((c) => clip(c.course.name));

    const gained = comps.map((c) => ({ skill: clip(c.skill, 60), level: c.level }));
    const gainedSet = new Set(gained.map((g) => g.skill.toLowerCase()));
    const gaps = Array.from(
      new Set(
        recommendable
          .flatMap((c) => c.skills)
          .filter((s) => s && !gainedSet.has(s.toLowerCase())),
      ),
    ).slice(0, 10);

    const next = badgeList.next;

    return {
      organizationId: scope.organizationId,
      learner: {
        id: userId,
        jobRole: profile?.job_role ?? null,
        jobLevel: profile?.job_level ?? null,
      },
      engagement: {
        assigned: coursesData.overview.totalAssigned,
        completed: coursesData.overview.completed,
        inProgress: coursesData.overview.inProgress,
        notStarted: coursesData.overview.assigned,
        overdue: overdue.length,
        failedAssessments: coursesData.overview.failed,
        certificatesEarned: courses.filter((c) => c.certificateId !== null).length,
        points: entry ? entry.points : null,
        monthPoints: entry ? entry.monthPoints : null,
        completionPct: entry ? entry.completionPct : null,
        rankLabel,
      },
      inProgress,
      overdue,
      pendingFeedback: {
        count: pendingFb.surveys.length,
        courses: pendingFb.surveys
          .map((s: Record<string, unknown>) =>
            typeof s.courseName === 'string'
              ? s.courseName
              : typeof s.name === 'string'
                ? s.name
                : null,
          )
          .filter((n): n is string => n !== null)
          .slice(0, 5)
          .map((n) => clip(n)),
      },
      pendingAssessments,
      recommendable: recommendable.map((c) => ({
        name: clip(c.name),
        category: c.category,
        skills: (c.skills ?? []).slice(0, 8).map((s) => clip(s, 60)),
      })),
      competencies: { gained, gaps },
      nearestBadge: next
        ? { label: next.label, description: next.description, hint: next.hint ?? null }
        : null,
    };
  }

  /** Whether the AI feature is switched on (and keyed). */
  isEnabled(): boolean {
    return this.ai.isEnabled();
  }

  /**
   * Generate and store this learner's recommendations. Returns null when the
   * feature is off or the model call fails (best-effort — never throws into a
   * request or a cron tick).
   */
  async generateForLearner(
    scope: OrgScope,
    userId: number,
  ): Promise<LearnerInsightsPayload | null> {
    if (!this.ai.isEnabled()) return null;
    try {
      const context = await this.buildContext(scope, userId);
      const payload = await this.ai.generateForTenant<LearnerInsightsPayload>(scope, {
        system: LEARNER_INSIGHTS_SYSTEM,
        user: JSON.stringify(context),
        jsonSchema: LEARNER_INSIGHTS_SCHEMA,
        contextOrgId: context.organizationId,
        subject: `learner=${userId}`,
      });
      if (!payload) return null;
      await this.ai.storeInsight(
        scope,
        'learner',
        userId,
        LEARNER_INSIGHTS_KIND,
        payload as unknown as Record<string, unknown>,
      );
      return payload;
    } catch (error) {
      this.logger.warn(
        `Learner insight generation failed for user=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Real-data charts for the panel's spider graph — NOT model output. A radar of
   * the learner's competency proficiency per skill domain, computed from
   * `user_skills` (§10.54's accuracy rule: the model narrates, it does not invent
   * the coordinates). Returns axes sorted for a stable shape; the panel draws a
   * radar only when there are at least three.
   */
  async buildCharts(scope: OrgScope, userId: number) {
    const comps = await this.competencies.listMyCompetencies(scope, userId);
    const byDomain = new Map<string, number[]>();
    for (const c of comps) {
      const domain = c.domain || 'General';
      const ranks = byDomain.get(domain) ?? [];
      ranks.push(levelRank(c.level));
      byDomain.set(domain, ranks);
    }
    const skillRadar = [...byDomain.entries()]
      .map(([axis, ranks]) => ({
        axis,
        value: Math.round(
          (ranks.reduce((a, b) => a + b, 0) / ranks.length / COMPETENCY_LEVELS.length) * 100,
        ),
      }))
      .sort((a, b) => a.axis.localeCompare(b.axis));
    return { skillRadar };
  }

  /** The stored insight for the dashboard panel, plus whether the feature is on. */
  async getInsights(scope: OrgScope, userId: number) {
    const [row, charts] = await Promise.all([
      this.ai.getInsight(scope, 'learner', userId, LEARNER_INSIGHTS_KIND),
      this.buildCharts(scope, userId),
    ]);
    return {
      enabled: this.ai.isEnabled(),
      insight: row
        ? { payload: row.payload, generatedAt: row.generated_at, model: row.model }
        : null,
      charts,
    };
  }

  /** On-demand regeneration behind the panel's Refresh button. */
  async refresh(scope: OrgScope, userId: number) {
    if (!this.ai.isEnabled()) {
      return { enabled: false as const, insight: null, charts: null, error: null };
    }
    const payload = await this.generateForLearner(scope, userId);
    const charts = await this.buildCharts(scope, userId);
    if (!payload) {
      return { enabled: true as const, insight: null, charts, error: 'generation_failed' };
    }
    const row = await this.ai.getInsight(
      scope,
      'learner',
      userId,
      LEARNER_INSIGHTS_KIND,
    );
    return {
      enabled: true as const,
      insight: {
        payload,
        generatedAt: row?.generated_at ?? new Date().toISOString(),
        model: row?.model ?? null,
      },
      charts,
      error: null,
    };
  }
}
