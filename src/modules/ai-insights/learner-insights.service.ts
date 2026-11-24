import { Injectable, Logger } from '@nestjs/common';

import { COMPETENCY_LEVELS, levelRank } from '@/common/competencies';
import {
  JOB_FUNCTION_LABELS,
  jobFunctionOf,
  rankForRole,
  type RoleFit,
} from '@/common/job-role-fit';
import type { OrgScope } from '@/database/org-scope';
import { AiInsightsService } from '@/modules/ai/ai-insights.service';
import { forModel } from '@/modules/ai/ai-tenant';
import { BadgesService } from '@/modules/badges/badges.service';
import { CompetenciesService } from '@/modules/competencies/competencies.service';
import { LeaderboardService } from '@/modules/leaderboard/leaderboard.service';
import { LearnerService } from '@/modules/learner/learner.service';
import { SurveysService } from '@/modules/surveys/surveys.service';

import { LearnerInsightsRepository } from './learner-insights.repository';
import {
  COURSE_RECOMMENDATIONS_KIND,
  COURSE_RECOMMENDATIONS_SCHEMA,
  COURSE_RECOMMENDATIONS_SYSTEM,
  LEARNER_INSIGHTS_KIND,
  LEARNER_INSIGHTS_SCHEMA,
  LEARNER_INSIGHTS_SYSTEM,
  SKILL_PLAN_KIND,
  SKILL_PLAN_SCHEMA,
  SKILL_PLAN_SYSTEM,
  type LearnerInsightsPayload,
} from './learner-insights.prompt';

/**
 * The deeper learner lenses beyond the coach (owner request 2026-11-19). Each is
 * its own stored `kind`, built from the SAME anonymised context and generated
 * through the same tenant-fenced chokepoint — so no new PII surface, and a lens
 * cannot cross tenants any more than the coach can.
 */
const LENSES = {
  course_recommendations: {
    kind: COURSE_RECOMMENDATIONS_KIND,
    system: COURSE_RECOMMENDATIONS_SYSTEM,
    schema: COURSE_RECOMMENDATIONS_SCHEMA,
  },
  skill_plan: {
    kind: SKILL_PLAN_KIND,
    system: SKILL_PLAN_SYSTEM,
    schema: SKILL_PLAN_SCHEMA,
  },
} as const;

export type LearnerLens = keyof typeof LENSES;

export function isLearnerLens(value: string): value is LearnerLens {
  return Object.prototype.hasOwnProperty.call(LENSES, value);
}

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
    /** The job function read from jobRole (common/job-role-fit.ts), or null. */
    jobFunction: string | null;
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
  /**
   * Courses the learner may be recommended, already filtered to their job
   * function and ranked best fit first. `roleFit` says why it is here: built
   * for their role, for a related role, or for everyone. A course built only
   * for another function never reaches this list.
   */
  recommendable: {
    name: string;
    category: string | null;
    skills: string[];
    roleFit: Exclude<RoleFit, 'off'>;
  }[];
  competencies: { gained: { skill: string; level: string }[]; gaps: string[] };
  nearestBadge: { label: string; description: string | null; hint: string | null } | null;
}

const DAY_MS = 86_400_000;

/**
 * Keep only recommendations naming a course in the role-filtered list, with
 * that list's `roleFit` attached. The model is told to choose only from it;
 * this makes it a guarantee rather than a request.
 */
function keepAllowed<T extends { name?: unknown }>(
  items: T[] | undefined,
  allowed: LearnerFeatureContext['recommendable'],
): (T & { roleFit: Exclude<RoleFit, 'off'> })[] {
  const byName = new Map(allowed.map((c) => [c.name.trim().toLowerCase(), c.roleFit]));
  return (items ?? []).flatMap((item) => {
    const fit =
      typeof item.name === 'string' ? byName.get(item.name.trim().toLowerCase()) : undefined;
    return fit ? [{ ...item, roleFit: fit }] : [];
  });
}

/**
 * The course-recommendations lens, filtered to the role list and carrying the
 * role it was matched to, so the panel can say "Matched to your role".
 */
function shapeRoleMatched(
  payload: Record<string, unknown>,
  context: LearnerFeatureContext,
) {
  const recs = Array.isArray(payload.recommendations)
    ? (payload.recommendations as { name?: unknown }[])
    : [];
  return {
    recommendations: keepAllowed(recs, context.recommendable),
    role: {
      jobRole: context.learner.jobRole,
      jobFunction: context.learner.jobFunction,
    },
  };
}

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
        // A wider pool than is sent, so filtering by role still leaves enough.
        this.repository.recommendableCourses(scope, userId, 80),
      ]);

    // Job-role fit (deterministic): off-role courses are removed here, so the
    // model can only ever choose from courses that suit this learner.
    const jobFn = jobFunctionOf(profile?.job_role ?? null);
    const fitted = rankForRole(recommendable, jobFn).slice(0, 20);

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
        fitted
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
        jobFunction: jobFn ? JOB_FUNCTION_LABELS[jobFn] : null,
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
      recommendable: fitted.map((c) => ({
        name: clip(c.name),
        category: c.category,
        skills: (c.skills ?? []).slice(0, 8).map((s) => clip(s, 60)),
        roleFit: c.roleFit,
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
        user: JSON.stringify(forModel(context)),
        jsonSchema: LEARNER_INSIGHTS_SCHEMA,
        contextOrgId: context.organizationId,
        subject: `learner=${userId}`,
      });
      if (!payload) return null;
      // Belt and braces: keep only courses from the role-filtered list.
      payload.recommendedCourses = keepAllowed(
        payload.recommendedCourses,
        context.recommendable,
      );
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
   * Real-data charts for the learner's AI Insights page — NOT model output
   * (§10.54's accuracy rule: the model narrates, it does not invent coordinates).
   *
   * Every number is REUSED from the canonical service that owns its definition —
   * competencies, My Courses, the leaderboard, badges — so a chart can never
   * disagree with the screen that shows the same figure. The learner page draws
   * many chart types from this one bundle (radar, donut, stacked bar, radial),
   * and the coach panel keeps reading `skillRadar` for its own spider graph.
   */
  async buildCharts(scope: OrgScope, userId: number) {
    const [comps, coursesData, standings, badgeList] = await Promise.all([
      this.competencies.listMyCompetencies(scope, userId),
      this.learner.courses(scope, userId),
      this.leaderboard.standings(scope),
      this.badges.listForLearner(scope, userId),
    ]);

    // Competency proficiency per domain (0-100), averaged over that domain's
    // skills — the coach's spider graph and the page's radar both read this.
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

    // How many skills each domain holds, and how they split across levels.
    const skillDomains = [...byDomain.entries()]
      .map(([domain, ranks]) => ({ domain, count: ranks.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const levelCounts = new Map<string, number>();
    for (const c of comps) levelCounts.set(c.level, (levelCounts.get(c.level) ?? 0) + 1);
    const competencyLevels = COMPETENCY_LEVELS.map((level) => ({
      level,
      count: levelCounts.get(level) ?? 0,
    }));

    const courses = coursesData.courses;
    const overview = coursesData.overview;

    // Course status donut, from the overview the canonical service computes.
    const courseStatus = [
      { status: 'Completed', value: overview.completed },
      { status: 'In Progress', value: overview.inProgress },
      { status: 'Not Started', value: overview.assigned },
      { status: 'Failed', value: overview.failed },
    ];

    // Progress split by course category — a stacked bar per category.
    const catMap = new Map<
      string,
      { completed: number; inProgress: number; notStarted: number }
    >();
    for (const c of courses) {
      const cat = c.category || 'Uncategorised';
      const row = catMap.get(cat) ?? { completed: 0, inProgress: 0, notStarted: 0 };
      if (c.status === 'completed') row.completed += 1;
      else if (c.status === 'in-progress' || c.progressPct > 0) row.inProgress += 1;
      else row.notStarted += 1;
      catMap.set(cat, row);
    }
    const categoryProgress = [...catMap.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort(
        (a, b) =>
          b.completed + b.inProgress + b.notStarted -
          (a.completed + a.inProgress + a.notStarted),
      )
      .slice(0, 8);

    // Badges earned vs available, split by tier, with the most recent few.
    const badgeDefs = badgeList.badges ?? [];
    const earnedBadges = badgeDefs.filter((b) => b.earned);
    const tierMap = new Map<string, { earned: number; total: number }>();
    for (const b of badgeDefs) {
      const tier = b.tier || 'Other';
      const row = tierMap.get(tier) ?? { earned: 0, total: 0 };
      row.total += 1;
      if (b.earned) row.earned += 1;
      tierMap.set(tier, row);
    }
    const badgesByTier = [...tierMap.entries()].map(([tier, v]) => ({ tier, ...v }));
    const recentBadges = earnedBadges
      .filter((b) => b.earnedAt)
      .sort(
        (a, b) =>
          new Date(b.earnedAt as string).getTime() -
          new Date(a.earnedAt as string).getTime(),
      )
      .slice(0, 6)
      .map((b) => ({ label: b.label, icon: b.icon, earnedAt: b.earnedAt }));

    const entry = standings.entries.find((e) => e.id === userId) ?? null;
    const ranked = standings.ranked.find((e) => e.id === userId) ?? null;
    const rankLabel =
      standings.settings.enabled && ranked && ranked.rank >= 1
        ? `#${ranked.rank} of ${standings.ranked.length}`
        : null;

    const certificates = courses.filter((c) => c.certificateId !== null).length;

    return {
      skillRadar,
      skillDomains,
      competencyLevels,
      courseStatus,
      categoryProgress,
      badges: {
        earned: earnedBadges.length,
        total: badgeDefs.length,
        byTier: badgesByTier,
        recent: recentBadges,
      },
      points: {
        points: entry ? entry.points : null,
        monthPoints: entry ? entry.monthPoints : null,
        completionPct: entry ? entry.completionPct : null,
        rankLabel,
      },
      totals: {
        assigned: overview.totalAssigned,
        completed: overview.completed,
        inProgress: overview.inProgress,
        notStarted: overview.assigned,
        failed: overview.failed,
        certificates,
        skills: comps.length,
        badgesEarned: earnedBadges.length,
      },
    };
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

  // ── Deeper lenses (course recommendations, skill plan) ────────────────────

  /** Generate and store one deeper lens. Best-effort — never throws. */
  async generateLens(
    scope: OrgScope,
    userId: number,
    lens: LearnerLens,
  ): Promise<Record<string, unknown> | null> {
    if (!this.ai.isEnabled()) return null;
    const spec = LENSES[lens];
    try {
      const context = await this.buildContext(scope, userId);
      const payload = await this.ai.generateForTenant<Record<string, unknown>>(scope, {
        system: spec.system,
        user: JSON.stringify(forModel(context)),
        jsonSchema: spec.schema,
        contextOrgId: context.organizationId,
        subject: `learner=${userId} lens=${lens}`,
      });
      if (!payload) return null;
      if (lens === 'course_recommendations') {
        Object.assign(payload, shapeRoleMatched(payload, context));
      }
      await this.ai.storeInsight(scope, 'learner', userId, spec.kind, payload);
      return payload;
    } catch (error) {
      this.logger.warn(
        `Lens ${lens} failed for user=${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** The stored lens for the page, plus whether the feature is on. */
  async getLens(scope: OrgScope, userId: number, lens: LearnerLens) {
    const row = await this.ai.getInsight(scope, 'learner', userId, LENSES[lens].kind);
    return {
      enabled: this.ai.isEnabled(),
      insight: row
        ? { payload: row.payload, generatedAt: row.generated_at, model: row.model }
        : null,
    };
  }

  /** On-demand regeneration for one lens (behind the page's button). */
  async refreshLens(scope: OrgScope, userId: number, lens: LearnerLens) {
    if (!this.ai.isEnabled()) {
      return { enabled: false as const, insight: null, error: null };
    }
    const payload = await this.generateLens(scope, userId, lens);
    if (!payload) {
      return { enabled: true as const, insight: null, error: 'generation_failed' };
    }
    const row = await this.ai.getInsight(scope, 'learner', userId, LENSES[lens].kind);
    return {
      enabled: true as const,
      insight: {
        payload,
        generatedAt: row?.generated_at ?? new Date().toISOString(),
        model: row?.model ?? null,
      },
      error: null,
    };
  }
}
