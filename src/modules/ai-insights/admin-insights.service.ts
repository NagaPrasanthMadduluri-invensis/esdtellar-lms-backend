import { Injectable, Logger } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { AiInsightsService } from '@/modules/ai/ai-insights.service';
import { AnalyticsService } from '@/modules/reports/analytics.service';

import { AdminInsightsRepository } from './admin-insights.repository';
import {
  AdminIntelligenceRepository,
  type CourseEffectivenessRow,
  type InactivityRow,
} from './admin-intelligence.repository';
import {
  ADMIN_INSIGHTS_KIND,
  ADMIN_INSIGHTS_SCHEMA,
  ADMIN_INSIGHTS_SYSTEM,
  type AdminInsightsPayload,
} from './admin-insights.prompt';

/**
 * Small-cell suppression floor. A department with fewer than this many learners
 * is never named to the model (its completion would effectively identify those
 * people); such departments are combined into one unnamed bucket, and any
 * deterministic signal sentence that names one is dropped (§10.54 re-identification
 * protection).
 */
const K_ANONYMITY = 5;

/** Cap a user-authored string before it enters the prompt (prompt-injection defence). */
function clip(value: string, max = 160): string {
  return value.length > max ? value.slice(0, max) : value;
}

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export interface CourseEffectiveness {
  name: string;
  category: string | null;
  enrolled: number;
  contentCompletionPct: number;
  avgScore: number | null;
  hasAssessment: boolean;
  flags: string[];
}

/** Turn raw per-course rows into effectiveness signals with honest flags. */
function mapCourseEffectiveness(rows: CourseEffectivenessRow[]): CourseEffectiveness[] {
  return rows.map((c) => {
    const denom = c.enrolled * c.lessons;
    const contentCompletionPct = denom > 0 ? clampPct((c.lesson_completions / denom) * 100) : 0;
    const flags: string[] = [];
    if (c.assessments === 0) flags.push('no assessment');
    if (c.lessons > 0 && contentCompletionPct < 40) flags.push('low completion');
    if (c.avg_score !== null && c.avg_score < 60) flags.push('low scores');
    return {
      name: clip(c.name, 80),
      category: c.category,
      enrolled: c.enrolled,
      contentCompletionPct,
      avgScore: c.avg_score,
      hasAssessment: c.assessments > 0,
      flags,
    };
  });
}

/** Risk radar: five severity dimensions (0-100, higher = worse), from real data. */
function riskRadarFrom(
  dash: Awaited<ReturnType<AnalyticsService['dashboard']>>,
  inactivity: InactivityRow,
  effectiveness: CourseEffectiveness[],
): { score: number; dimensions: { axis: string; value: number }[] } {
  const total = dash.headline.totalLearners || 0;
  const needing = effectiveness.filter((c) => c.flags.length > 0).length;
  const dimensions = [
    { axis: 'Overdue load', value: clampPct(total ? (dash.headline.overdue / total) * 100 : 0) },
    { axis: 'Inactivity', value: inactivity.total ? clampPct((inactivity.inactive / inactivity.total) * 100) : 0 },
    { axis: 'Low completion', value: clampPct(100 - dash.headline.completionRate) },
    { axis: 'Assessment risk', value: clampPct(100 - dash.engagement.passRate) },
    { axis: 'Course quality', value: effectiveness.length ? clampPct((needing / effectiveness.length) * 100) : 0 },
  ];
  const score = Math.round(dimensions.reduce((a, d) => a + d.value, 0) / dimensions.length);
  return { score, dimensions };
}

/**
 * The anonymised ORG context sent to the model (spec §7 PII surface, reviewed
 * before the feature is enabled). It carries only aggregates, department names,
 * course/session titles and ready-made signal sentences, never an individual.
 */
export interface OrgFeatureContext {
  /** The single org this context was built for — asserted at the generation
   *  chokepoint (ai-tenant.ts) before anything leaves the box. */
  organizationId: number;
  org: {
    totalLearners: number;
    activeLearners: number;
    completionRate: number;
    inProgress: number;
    overdue: number;
  };
  engagement: {
    avgScore: number | null;
    passRate: number;
    totalHours: number;
    hoursThisMonth: number;
    certificatesIssued: number;
    activeCourses: number;
  };
  healthScore: { score: number; dimensions: { axis: string; value: number }[] };
  statusBreakdown: { status: string; value: number }[];
  departments: { dept: string; learners: number; completionPct: number; hours: number }[];
  signals: string[];
  negativeFeedback: {
    courses: { name: string; avgRating: number; responses: number }[];
    sessions: { name: string; avgRating: number; responses: number }[];
  };
  intelligence: {
    inactiveLearners: number;
    activeLearnerTotal: number;
    riskScore: number;
    coursesNeedingAttention: { name: string; flags: string[] }[];
    skillDomains: { domain: string; learners: number; avgLevelPct: number }[];
  };
}

@Injectable()
export class AdminInsightsService {
  private readonly logger = new Logger('AdminInsights');

  constructor(
    private readonly ai: AiInsightsService,
    private readonly repository: AdminInsightsRepository,
    private readonly analytics: AnalyticsService,
    private readonly intel: AdminIntelligenceRepository,
  ) {}

  /**
   * Build the org context. The headline numbers, engagement, status split,
   * department roll-up and the deterministic signal sentences are REUSED from
   * `AnalyticsService.dashboard` (§10.54) so the AI briefing can never disagree
   * with the admin's own analytics page. Only the negative-feedback aggregates
   * are read here.
   */
  async buildContext(scope: OrgScope): Promise<OrgFeatureContext> {
    const [dash, lowCourses, lowSessions, inactivity, courseRows, domains] =
      await Promise.all([
        this.analytics.dashboard(scope),
        this.repository.lowRatedCourses(scope),
        this.repository.lowRatedSessions(scope),
        this.intel.inactivity(scope, 30),
        this.intel.courseEffectiveness(scope),
        this.intel.skillDomains(scope),
      ]);
    const effectiveness = mapCourseEffectiveness(courseRows);

    // Small-group re-identification protection: departments below the floor are
    // never named; they are combined into one unnamed bucket, and any signal
    // sentence that mentions one is dropped.
    type DeptRow = { dept: string; total: number; pct: number; hours_learning: number };
    const deptRows = dash.deptCompletion as DeptRow[];
    const named = deptRows.filter((d) => Number(d.total) >= K_ANONYMITY);
    const small = deptRows.filter((d) => Number(d.total) < K_ANONYMITY);

    const departments = named.map((d) => ({
      dept: clip(d.dept, 80),
      learners: Number(d.total),
      completionPct: d.pct,
      hours: d.hours_learning,
    }));
    if (small.length > 0) {
      const learners = small.reduce((a, d) => a + Number(d.total), 0);
      const hours = small.reduce((a, d) => a + Number(d.hours_learning), 0);
      const weightedPct = learners
        ? Math.round(small.reduce((a, d) => a + d.pct * Number(d.total), 0) / learners)
        : 0;
      departments.push({
        dept: 'Smaller departments (combined)',
        learners,
        completionPct: weightedPct,
        hours,
      });
    }
    const smallNames = small.map((d) => d.dept).filter(Boolean);
    const signals = dash.insights
      .map((i: { text: string }) => clip(i.text, 400))
      .filter((text: string) => !smallNames.some((n) => text.includes(n)));

    return {
      organizationId: scope.organizationId,
      org: {
        totalLearners: dash.headline.totalLearners,
        activeLearners: dash.headline.activeLearners,
        completionRate: dash.headline.completionRate,
        inProgress: dash.headline.inProgress,
        overdue: dash.headline.overdue,
      },
      engagement: {
        avgScore: dash.engagement.avgScore,
        passRate: dash.engagement.passRate,
        totalHours: dash.engagement.totalHours,
        hoursThisMonth: dash.engagement.hoursThisMonth,
        certificatesIssued: dash.engagement.certificatesIssued,
        activeCourses: dash.engagement.activeCourses,
      },
      healthScore: this.healthFrom(dash),
      statusBreakdown: dash.statusBreakdown,
      departments,
      signals,
      negativeFeedback: {
        courses: lowCourses.map((c) => ({
          name: clip(c.name),
          avgRating: Number(c.avg_rating),
          responses: c.responses,
        })),
        sessions: lowSessions.map((s) => ({
          name: clip(s.name),
          avgRating: Number(s.avg_rating),
          responses: s.responses,
        })),
      },
      intelligence: {
        inactiveLearners: inactivity.inactive,
        activeLearnerTotal: inactivity.total,
        riskScore: riskRadarFrom(dash, inactivity, effectiveness).score,
        coursesNeedingAttention: effectiveness
          .filter((c) => c.flags.length > 0)
          .slice(0, 8)
          .map((c) => ({ name: c.name, flags: c.flags })),
        skillDomains: domains.slice(0, 8).map((d) => ({
          domain: d.domain,
          learners: d.learners,
          avgLevelPct: d.avg_level_pct,
        })),
      },
    };
  }

  /**
   * The Learning Health Score — a real-data radar, NOT model output. An
   * explainable 0-100 composite over four dimensions the org already measures
   * (§10.54's accuracy rule). The panel draws a radial gauge + a 4-axis radar
   * from this; the model only narrates it.
   */
  private healthFrom(
    dash: Awaited<ReturnType<AnalyticsService['dashboard']>>,
  ): { score: number; dimensions: { axis: string; value: number }[] } {
    const total = dash.headline.totalLearners || 0;
    const participation = total
      ? Math.round((dash.headline.activeLearners / total) * 100)
      : 0;
    const certification = total
      ? Math.min(100, Math.round((dash.engagement.certificatesIssued / total) * 100))
      : 0;
    const dimensions = [
      { axis: 'Completion', value: dash.headline.completionRate },
      { axis: 'Assessment', value: dash.engagement.passRate },
      { axis: 'Participation', value: participation },
      { axis: 'Certification', value: certification },
    ];
    const score = Math.round(
      dimensions.reduce((a, d) => a + d.value, 0) / dimensions.length,
    );
    return { score, dimensions };
  }

  /**
   * The full Learning Intelligence payload (real data): risk radar, inactivity,
   * course effectiveness, courses needing attention, organisational skill
   * intelligence, and department benchmarks. Deterministic — the AI briefing
   * narrates these; this endpoint is the numbers behind it.
   */
  async intelligence(scope: OrgScope) {
    const [dash, inactivity, courseRows, domains] = await Promise.all([
      this.analytics.dashboard(scope),
      this.intel.inactivity(scope, 30),
      this.intel.courseEffectiveness(scope),
      this.intel.skillDomains(scope),
    ]);
    const effectiveness = mapCourseEffectiveness(courseRows);
    const named = (dash.deptCompletion as { dept: string; total: number; pct: number; hours_learning: number }[])
      .filter((d) => Number(d.total) >= K_ANONYMITY)
      .map((d) => ({
        dept: d.dept,
        learners: Number(d.total),
        completionPct: d.pct,
        hours: Number(d.hours_learning),
      }));
    return {
      // Composite health, from the four dimensions the org already measures — a
      // radial gauge plus a 4-axis radar.
      healthScore: this.healthFrom(dash),
      riskRadar: riskRadarFrom(dash, inactivity, effectiveness),
      // The KPI figures the page draws as gauges and stat tiles. Reused from the
      // one dashboard aggregate, so the AI page cannot disagree with Analytics.
      headline: {
        totalLearners: dash.headline.totalLearners,
        activeLearners: dash.headline.activeLearners,
        completionRate: dash.headline.completionRate,
        inProgress: dash.headline.inProgress,
        overdue: dash.headline.overdue,
      },
      engagement: {
        avgScore: dash.engagement.avgScore,
        passRate: dash.engagement.passRate,
        totalHours: dash.engagement.totalHours,
        hoursThisMonth: dash.engagement.hoursThisMonth,
        avgHoursPerLearner: dash.engagement.avgHoursPerLearner,
        certificatesIssued: dash.engagement.certificatesIssued,
        activeCourses: dash.engagement.activeCourses,
      },
      // Course-status donut — the same split the admin dashboard shows.
      statusBreakdown: dash.statusBreakdown,
      inactivity: { inactive: inactivity.inactive, total: inactivity.total, days: 30 },
      courseEffectiveness: effectiveness.slice(0, 20),
      coursesNeedingAttention: effectiveness.filter((c) => c.flags.length > 0).slice(0, 10),
      skillIntelligence: {
        tagged: domains.length > 0,
        domains: domains.map((d) => ({
          domain: d.domain,
          learners: d.learners,
          avgLevelPct: d.avg_level_pct,
        })),
      },
      departments: named,
    };
  }

  isEnabled(): boolean {
    return this.ai.isEnabled();
  }

  /** Generate and store the org briefing. Best-effort — never throws. */
  async generateForOrg(scope: OrgScope): Promise<AdminInsightsPayload | null> {
    if (!this.ai.isEnabled()) return null;
    try {
      const context = await this.buildContext(scope);
      const payload = await this.ai.generateForTenant<AdminInsightsPayload>(scope, {
        system: ADMIN_INSIGHTS_SYSTEM,
        user: JSON.stringify(context),
        jsonSchema: ADMIN_INSIGHTS_SCHEMA,
        contextOrgId: context.organizationId,
        subject: 'org',
      });
      if (!payload) return null;
      await this.ai.storeInsight(
        scope,
        'org',
        scope.organizationId,
        ADMIN_INSIGHTS_KIND,
        payload as unknown as Record<string, unknown>,
      );
      return payload;
    } catch (error) {
      this.logger.warn(
        `Org insight generation failed for org=${scope.organizationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  async getInsights(scope: OrgScope) {
    const [row, dash] = await Promise.all([
      this.ai.getInsight(scope, 'org', scope.organizationId, ADMIN_INSIGHTS_KIND),
      this.analytics.dashboard(scope),
    ]);
    return {
      enabled: this.ai.isEnabled(),
      insight: row
        ? { payload: row.payload, generatedAt: row.generated_at, model: row.model }
        : null,
      charts: { healthScore: this.healthFrom(dash) },
    };
  }

  async refresh(scope: OrgScope) {
    if (!this.ai.isEnabled()) {
      return { enabled: false as const, insight: null, charts: null, error: null };
    }
    const payload = await this.generateForOrg(scope);
    const charts = { healthScore: this.healthFrom(await this.analytics.dashboard(scope)) };
    if (!payload) {
      return { enabled: true as const, insight: null, charts, error: 'generation_failed' };
    }
    const row = await this.ai.getInsight(
      scope,
      'org',
      scope.organizationId,
      ADMIN_INSIGHTS_KIND,
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
