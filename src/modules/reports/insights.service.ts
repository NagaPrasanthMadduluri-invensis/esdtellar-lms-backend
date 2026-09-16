import { Injectable } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { JOB_LEVELS, LOCATIONS } from '@/common/workforce';
import { LearningHoursService } from '@/modules/learning-hours/learning-hours.service';

import {
  InsightsRepository,
  type AudienceFilter,
  type CompletionFilterRow,
} from './insights.repository';
import {
  buildPeriods,
  foldByPeriod,
  reportWindow,
  REPORT_WINDOWS,
  type Granularity,
  type Period,
} from './periods.util';

/** One rendered report: KPIs above, a chart beside them, a table below. */
export interface BuiltReport {
  key: string;
  title: string;
  kpis: { label: string; value: string }[];
  columns: string[];
  rows: (string | number)[][];
  /** Omitted when the report has nothing worth plotting. */
  chart?: { labels: string[]; data: number[]; axisLabel: string };
  /** True when `rows` was truncated — the UI says so rather than lying. */
  truncated?: boolean;
  totalRows: number;
}

/**
 * The report catalogue.
 *
 * FIVE, not the eight the reference mock offers. The three left out are left
 * out because nothing backs them, and a report type that always returns an
 * empty table is the screen-that-lies failure §5.2.1 exists to prevent:
 *
 *   Learning Path Progress   `journeys` is empty — the feature shipped, the
 *                            content has not been authored yet.
 *   Certificates Issued      backed now (the history seed issues them), but
 *                            folded into Course Completion rather than given
 *                            its own type, since every certificate here
 *                            follows a completion already in that report.
 *   Enrolments self/assigned there is no self-enrolment in this product. Every
 *                            assignment is made by an admin, so the split
 *                            would be 100%/0% by construction.
 *
 * When journeys carry data or self-enrolment exists, the type is added here
 * and its builder beside it — the same one-change rule the permission
 * catalogue follows.
 */
export const REPORT_TYPES = [
  { key: 'completion', label: 'Course Completion' },
  { key: 'hours', label: 'Learning Hours' },
  { key: 'assessment', label: 'Assessment Results' },
  { key: 'attendance', label: 'Session Attendance' },
  { key: 'trainer', label: 'Trainer Delivery' },
] as const;

export type ReportTypeKey = (typeof REPORT_TYPES)[number]['key'];

/** Dimensions a Comparison can put side by side. */
export const COMPARISON_DIMENSIONS = [
  { key: 'department', label: 'Departments' },
  { key: 'location', label: 'Locations' },
  { key: 'jobLevel', label: 'Job levels' },
  { key: 'jobRole', label: 'Job roles' },
  { key: 'individual', label: 'Individuals' },
] as const;

/** Metrics a Comparison can measure those dimensions on. */
export const COMPARISON_METRICS = [
  { key: 'completion', label: 'Course completion', unit: '%' },
  { key: 'hours', label: 'Learning hours', unit: 'h' },
  { key: 'enrolments', label: 'Enrolments', unit: '' },
  { key: 'score', label: 'Assessment results', unit: '%' },
  { key: 'certificates', label: 'Certificates issued', unit: '' },
] as const;

/**
 * Rows returned per report section.
 *
 * §7.6 says paginate anything unbounded, and a completion report over a large
 * tenant is exactly that. The cap is applied AFTER the KPIs are computed, so
 * the summary always describes the whole result and only the table is
 * shortened — a truncated table beside a truncated total would be wrong twice.
 */
const ROW_CAP = 500;

/** How stale a partly-finished course must be to count as needing a nudge. */
const STALE_DAYS = 14;

export interface ReportSpec {
  types: ReportTypeKey[];
  window: string;
  filter: AudienceFilter;
  userId?: number;
}

export interface ComparisonSpec {
  dimension: string;
  items: string[];
  metrics: string[];
  window: string;
}

@Injectable()
export class InsightsService {
  constructor(
    private readonly repository: InsightsRepository,
    /**
     * Hours come from here and nowhere else (§10.4). This service never sums a
     * duration_minutes of its own — every figure below that is measured in
     * hours traces back to `lessonSource`.
     */
    private readonly hours: LearningHoursService,
  ) {}

  // ═══════════════════════════ ANALYTICS ═══════════════════════════════

  async analytics(scope: OrgScope, granularity: Granularity) {
    const extent = await this.repository.activityExtent(scope);
    const periods = buildPeriods(granularity, extent.first, extent.last);

    const [
      minutesRows,
      modeRows,
      deptMinutes,
      enrollments,
      completions,
      flow,
      certificates,
      learners,
      learnerMinutes,
    ] = await Promise.all([
      this.hours.minutesByPeriod(scope, 'month'),
      this.hours.minutesByPeriodAndMode(scope, 'month'),
      this.hours.minutesByDepartment(scope),
      this.repository.enrollmentsByPeriod(scope, 'month'),
      this.repository.courseCompletionsByPeriod(scope, 'month'),
      this.repository.learnerFlowByPeriod(scope, 'month'),
      this.repository.certificatesByPeriod(scope, 'month'),
      this.repository.learnerEngagement(scope),
      this.hours.minutesByUser(scope),
    ]);

    const hoursSeries = this.fold(periods, minutesRows, (r) => Number(r.minutes) / 60);
    const enrollSeries = this.fold(periods, enrollments, (r) => Number(r.n));
    const completeSeries = this.fold(periods, completions, (r) => Number(r.n));
    const joinedSeries = this.fold(periods, flow, (r) => Number(r.joined));
    const activeSeries = this.fold(periods, flow, (r) => Number(r.active));
    const certSeries = this.fold(periods, certificates, (r) => Number(r.n));

    // Mode of learning — one folded series per mode, zero-filled so the
    // stacked bars line up even where a mode was unused in a period.
    const modeNames = [...new Set(modeRows.map((r) => r.mode))].sort();
    const modeSeries = modeNames.map((mode) => ({
      mode,
      data: periods.map(
        (p) =>
          this.fold(
            periods,
            modeRows.filter((r) => r.mode === mode),
            (r) => Number(r.minutes) / 60,
          ).get(p.key) ?? 0,
      ),
    }));

    // Type of learning is the same minutes re-bucketed: a session is
    // instructor-led, everything else is self-paced. Derived from the mode
    // split rather than queried again, so the two charts always agree.
    const instructorLed = new Set(['ILT', 'VILT']);
    const typeSeries = ['Self-paced', 'Instructor-led'].map((type) => ({
      type,
      data: periods.map((_, i) =>
        modeSeries
          .filter((m) =>
            type === 'Instructor-led' ? instructorLed.has(m.mode) : !instructorLed.has(m.mode),
          )
          .reduce((a, m) => a + (m.data[i] ?? 0), 0),
      ),
    }));

    const totalMinutes = minutesRows.reduce((a, r) => a + Number(r.minutes), 0);
    const activeLearners = learners.length;
    const topDept = deptMinutes[0] ?? null;

    return {
      granularity,
      periods: periods.map((p) => ({ key: p.key, label: p.label })),
      /**
       * Whether the axis is long enough to read as a trend. Two points are a
       * line segment, not a trend, and a page that draws one anyway invites a
       * conclusion the data cannot support — so the UI shows a note instead.
       */
      sufficient: periods.filter((p) => (hoursSeries.get(p.key) ?? 0) > 0).length >= 3,
      engagement: {
        totalHours: round1(totalMinutes / 60),
        avgPerLearner: activeLearners ? round1(totalMinutes / 60 / activeLearners) : 0,
        topDepartment: topDept
          ? { name: topDept.department, hours: round1(Number(topDept.minutes) / 60) }
          : null,
      },
      series: {
        hours: this.series(periods, hoursSeries),
        enrollments: this.series(periods, enrollSeries),
        completions: this.series(periods, completeSeries),
        learnersJoined: this.series(periods, joinedSeries),
        learnersActive: this.series(periods, activeSeries),
        certificates: this.series(periods, certSeries),
        modes: modeSeries.map((m) => ({ name: m.mode, data: m.data.map(round1) })),
        types: typeSeries.map((t) => ({ name: t.type, data: t.data.map(round1) })),
      },
      departmentEngagement: deptMinutes.map((d) => ({
        department: d.department,
        learners: Number(d.learners),
        hours: round1(Number(d.minutes) / 60),
      })),
      learnerEngagement: learners
        .map((l) => {
          const m = learnerMinutes.get(Number(l.id));
          return {
            id: l.id,
            name: `${l.first_name} ${l.last_name}`,
            department: l.department,
            job_level: l.job_level,
            location: l.location,
            thisMonthHours: round1((m?.thisMonth ?? 0) / 60),
            allTimeHours: round1((m?.all ?? 0) / 60),
          };
        })
        .sort((a, b) => b.allTimeHours - a.allTimeHours),
      insights: this.analyticsInsights(
        periods,
        hoursSeries,
        completeSeries,
        joinedSeries,
        deptMinutes,
        modeSeries,
      ),
    };
  }

  /**
   * The narrative panel.
   *
   * Every sentence is derived from a number already on the page, so the panel
   * can never claim something the charts below it contradict. It is written
   * here rather than in the UI because the comparison it makes — this period
   * against the one before — needs the unrounded series.
   */
  private analyticsInsights(
    periods: Period[],
    hours: Map<string, number>,
    completions: Map<string, number>,
    joined: Map<string, number>,
    deptMinutes: { department: string; minutes: number; learners: number }[],
    modes: { mode: string; data: number[] }[],
  ) {
    const out: { icon: string; text: string }[] = [];
    if (periods.length === 0) return out;

    const last = periods[periods.length - 1];
    const prev = periods[periods.length - 2];

    if (prev) {
      const a = hours.get(prev.key) ?? 0;
      const b = hours.get(last.key) ?? 0;
      if (a > 0) {
        const delta = Math.round(((b - a) / a) * 100);
        out.push({
          icon: 'clock',
          text: `Learning hours ${delta >= 0 ? 'grew' : 'fell'} ${Math.abs(delta)}% from ${prev.label} to ${last.label} (${round1(b)}h).`,
        });
      }
      const ca = completions.get(prev.key) ?? 0;
      const cb = completions.get(last.key) ?? 0;
      out.push({
        icon: 'check',
        text: `${cb} course completion${cb === 1 ? '' : 's'} in ${last.label}, against ${ca} in ${prev.label}.`,
      });
    }

    if (deptMinutes.length >= 2) {
      const top = deptMinutes[0];
      const bottom = deptMinutes[deptMinutes.length - 1];
      out.push({
        icon: 'trophy',
        text: `${top.department} leads on engagement at ${round1(Number(top.minutes) / 60)}h; ${bottom.department} is furthest behind and may need a nudge.`,
      });
    }

    // Fastest-growing mode, first half of the axis against the second.
    const half = Math.floor(periods.length / 2);
    if (half >= 1 && modes.length > 0) {
      let best: { mode: string; growth: number } | null = null;
      for (const m of modes) {
        const early = m.data.slice(0, half).reduce((a, v) => a + v, 0);
        const late = m.data.slice(half).reduce((a, v) => a + v, 0);
        if (early <= 0) continue;
        const growth = Math.round(((late - early) / early) * 100);
        if (!best || growth > best.growth) best = { mode: m.mode, growth };
      }
      if (best && best.growth > 0) {
        out.push({
          icon: 'trend',
          text: `${best.mode} is the fastest-growing mode of learning across the period (+${best.growth}%).`,
        });
      }
    }

    const totalJoined = [...joined.values()].reduce((a, v) => a + v, 0);
    if (totalJoined > 0) {
      out.push({
        icon: 'user',
        text: `${totalJoined} learner${totalJoined === 1 ? '' : 's'} onboarded over this period.`,
      });
    }
    return out;
  }

  private fold<T>(periods: Period[], rows: T[], value: (r: T) => number) {
    return foldByPeriod(
      periods,
      rows.map((r) => ({
        period: String((r as unknown as { period: string }).period),
        value: value(r),
      })),
    );
  }

  private series(periods: Period[], folded: Map<string, number>): number[] {
    return periods.map((p) => round1(folded.get(p.key) ?? 0));
  }

  // ═══════════════════════════ REPORTS ═════════════════════════════════

  /** Everything the builder's controls need, with the live filter values. */
  async reportOptions(scope: OrgScope) {
    const [rows, learners] = await Promise.all([
      this.repository.filterOptions(scope),
      this.repository.learnersFiltered(scope, {}),
    ]);
    const of = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.value);
    return {
      types: REPORT_TYPES.map((t) => ({ ...t })),
      windows: REPORT_WINDOWS.map((w) => ({ ...w })),
      dimensions: COMPARISON_DIMENSIONS.map((d) => ({ ...d })),
      metrics: COMPARISON_METRICS.map((m) => ({ ...m })),
      filters: {
        departments: of('department'),
        // The two closed lists are offered in FULL, not only the values
        // currently in use: an admin filtering for a location with nobody in
        // it should see an empty report, which is an answer, rather than find
        // the option missing and wonder whether the filter is broken.
        locations: [...LOCATIONS],
        jobLevels: [...JOB_LEVELS],
        jobRoles: of('jobRole'),
      },
      learners: learners.map((l) => ({
        id: l.id,
        name: `${l.first_name} ${l.last_name}`,
        department: l.department,
      })),
    };
  }

  /**
   * A Group report — one section per selected type.
   *
   * `full` is passed only by the export routes, and means "do not apply the
   * row cap". The screen and the file are otherwise built by the same code,
   * so a download can never disagree with what the admin just looked at.
   */
  async buildGroup(
    scope: OrgScope,
    spec: ReportSpec,
    full = false,
  ): Promise<{ window: string; reports: BuiltReport[] }> {
    const w = reportWindow(spec.window);
    const reports: BuiltReport[] = [];
    for (const type of spec.types) {
      const built = await this.buildOne(scope, type, w, spec.filter, spec.userId, full);
      if (built) reports.push(built);
    }
    return { window: w.label, reports };
  }

  /** An Individual report — one person, every course and attempt they have. */
  async buildIndividual(scope: OrgScope, userId: number, windowKey: string) {
    const w = reportWindow(windowKey);
    const [learners, assignments, attempts, minutes] = await Promise.all([
      this.repository.learnersFiltered(scope, {}, userId),
      this.repository.assignmentsFiltered(scope, {}, userId),
      this.repository.attemptsFiltered(scope, {}, userId),
      this.hours.minutesByUserInWindow(scope, w.from, w.to),
    ]);
    const person = learners[0] ?? null;
    if (!person) return { window: w.label, person: null, report: null };

    const inWindow = assignments.filter((a) =>
      within(a.last_completed_at ?? a.assigned_at, w),
    );
    const completed = inWindow.filter((a) => isComplete(a));
    const scored = attempts.filter((a) => within(a.submitted_at, w));
    const mins = minutes.get(userId)?.minutes ?? 0;

    const report: BuiltReport = {
      key: 'individual',
      title: `Individual report — ${person.first_name} ${person.last_name}`,
      kpis: [
        { label: 'Courses in window', value: String(inWindow.length) },
        { label: 'Completed', value: String(completed.length) },
        { label: 'Avg score', value: `${avg(scored.map((a) => Number(a.percentage)))}%` },
        { label: 'Learning hours', value: `${round1(mins / 60)}h` },
        { label: 'Attempts', value: String(scored.length) },
      ],
      columns: ['Course', 'Progress', 'Status', 'Best score', 'Last activity'],
      rows: inWindow.map((a) => [
        a.course_name,
        `${percent(a.completed_lessons, a.total_lessons)}%`,
        statusOf(a),
        a.best_score === null ? '—' : `${Math.round(Number(a.best_score))}%`,
        (a.last_completed_at ?? a.assigned_at).slice(0, 10),
      ]),
      totalRows: inWindow.length,
    };

    return {
      window: w.label,
      person: {
        id: person.id,
        name: `${person.first_name} ${person.last_name}`,
        email: person.email,
        department: person.department,
        location: person.location,
        job_role: person.job_role,
        job_level: person.job_level,
      },
      report,
    };
  }

  /** A Comparison — N items of one dimension, side by side on M metrics. */
  async buildComparison(scope: OrgScope, spec: ComparisonSpec): Promise<{ window: string; reports: BuiltReport[] }> {
    const w = reportWindow(spec.window);
    const dimension = COMPARISON_DIMENSIONS.find((d) => d.key === spec.dimension);
    if (!dimension || spec.items.length === 0) return { window: w.label, reports: [] };

    const [assignments, attempts, minutes, learners] = await Promise.all([
      this.repository.assignmentsFiltered(scope, {}),
      this.repository.attemptsFiltered(scope, {}),
      this.hours.minutesByUserInWindow(scope, w.from, w.to),
      this.repository.learnersFiltered(scope, {}),
    ]);

    /** Which learners belong to one compared item. */
    const membersOf = (item: string): Set<number> => {
      if (dimension.key === 'individual') return new Set([Number(item)]);
      const column =
        dimension.key === 'department' ? 'department'
        : dimension.key === 'location' ? 'location'
        : dimension.key === 'jobLevel' ? 'job_level'
        : 'job_role';
      return new Set(
        learners
          .filter((l) => (l as unknown as Record<string, string | null>)[column] === item)
          .map((l) => Number(l.id)),
      );
    };
    const labelOf = (item: string) => {
      if (dimension.key !== 'individual') return item;
      const l = learners.find((x) => String(x.id) === String(item));
      return l ? `${l.first_name} ${l.last_name}` : item;
    };

    const reports: BuiltReport[] = [];
    for (const metricKey of spec.metrics) {
      const metric = COMPARISON_METRICS.find((m) => m.key === metricKey);
      if (!metric) continue;

      const data = spec.items.map((item) => {
        const members = membersOf(item);
        const mine = assignments.filter(
          (a) => members.has(Number(a.user_id)) && within(a.last_completed_at ?? a.assigned_at, w),
        );
        let value = 0;
        if (metric.key === 'completion') {
          value = mine.length ? Math.round((mine.filter(isComplete).length / mine.length) * 100) : 0;
        } else if (metric.key === 'enrolments') {
          value = mine.length;
        } else if (metric.key === 'score') {
          value = avg(
            attempts
              .filter((a) => members.has(Number(a.user_id)) && within(a.submitted_at, w))
              .map((a) => Number(a.percentage)),
          );
        } else if (metric.key === 'hours') {
          const total = [...members].reduce((sum, id) => sum + (minutes.get(id)?.minutes ?? 0), 0);
          value = round1(total / 60);
        } else if (metric.key === 'certificates') {
          // A certificate follows a completion in this product, so the count
          // of completed-and-passed courses is the same number without a
          // second query. Kept explicit rather than aliased to `completion`
          // because the two diverge the moment manual issue is used.
          value = mine.filter((a) => isComplete(a) && Number(a.best_score ?? 0) >= 60).length;
        }
        return { label: labelOf(item), value };
      });

      reports.push({
        key: `cmp-${metric.key}`,
        title: `${metric.label} by ${dimension.label.toLowerCase()}`,
        kpis: data.map((d) => ({ label: d.label, value: `${d.value}${metric.unit}` })),
        columns: [dimension.label.replace(/s$/, ''), metric.label],
        rows: data.map((d) => [d.label, `${d.value}${metric.unit}`]),
        chart: {
          labels: data.map((d) => d.label),
          data: data.map((d) => d.value),
          axisLabel: metric.label,
        },
        totalRows: data.length,
      });
    }
    return { window: w.label, reports };
  }

  // ── One group-report section ──────────────────────────────────────────

  private async buildOne(
    scope: OrgScope,
    type: ReportTypeKey,
    w: { from: string; to: string; label: string },
    filter: AudienceFilter,
    userId?: number,
    full = false,
  ): Promise<BuiltReport | null> {
    if (type === 'completion') {
      const all = await this.repository.assignmentsFiltered(scope, filter, userId);
      const inWindow = all.filter((a) => within(a.last_completed_at ?? a.assigned_at, w));
      const done = inWindow.filter(isComplete);
      const scores = done.map((a) => Number(a.best_score)).filter((n) => !Number.isNaN(n) && n > 0);
      return cap({
        key: type,
        title: 'Course completion',
        kpis: [
          { label: 'Completions', value: String(done.length) },
          { label: 'Enrolments in window', value: String(inWindow.length) },
          { label: 'Completion rate', value: `${percent(done.length, inWindow.length)}%` },
          { label: 'Avg score', value: `${avg(scores)}%` },
        ],
        columns: ['Learner', 'Department', 'Location', 'Course', 'Progress', 'Completed on', 'Score'],
        rows: inWindow
          .sort((a, b) => (b.last_completed_at ?? '').localeCompare(a.last_completed_at ?? ''))
          .map((a) => [
            `${a.first_name} ${a.last_name}`,
            a.department ?? '—',
            a.location ?? '—',
            a.course_name,
            `${percent(a.completed_lessons, a.total_lessons)}%`,
            isComplete(a) && a.last_completed_at ? a.last_completed_at.slice(0, 10) : '—',
            a.best_score === null ? '—' : `${Math.round(Number(a.best_score))}%`,
          ]),
        chart: {
          labels: ['Enrolments', 'Completions'],
          data: [inWindow.length, done.length],
          axisLabel: 'Courses',
        },
        totalRows: inWindow.length,
      }, full);
    }

    if (type === 'hours') {
      const [learners, minutes] = await Promise.all([
        this.repository.learnersFiltered(scope, filter, userId),
        this.hours.minutesByUserInWindow(scope, w.from, w.to),
      ]);
      const rows = learners.map((l) => {
        const m = minutes.get(Number(l.id));
        return {
          name: `${l.first_name} ${l.last_name}`,
          department: l.department ?? '—',
          location: l.location ?? '—',
          level: l.job_level ?? '—',
          windowHours: round1((m?.minutes ?? 0) / 60),
          allTimeHours: round1((m?.allTime ?? 0) / 60),
        };
      }).sort((a, b) => b.windowHours - a.windowHours);
      const total = rows.reduce((a, r) => a + r.windowHours, 0);
      return cap({
        key: type,
        title: 'Learning hours',
        kpis: [
          { label: 'Hours in window', value: `${round1(total)}h` },
          { label: 'Learners', value: String(rows.length) },
          { label: 'Avg per learner', value: `${rows.length ? round1(total / rows.length) : 0}h` },
          { label: 'All-time hours', value: `${round1(rows.reduce((a, r) => a + r.allTimeHours, 0))}h` },
        ],
        columns: ['Learner', 'Department', 'Location', 'Job level', 'Hours (window)', 'Hours (all time)'],
        rows: rows.map((r) => [r.name, r.department, r.location, r.level, `${r.windowHours}h`, `${r.allTimeHours}h`]),
        chart: {
          labels: rows.slice(0, 10).map((r) => r.name),
          data: rows.slice(0, 10).map((r) => r.windowHours),
          axisLabel: 'Hours',
        },
        totalRows: rows.length,
      }, full);
    }

    if (type === 'assessment') {
      const all = await this.repository.attemptsFiltered(scope, filter, userId);
      const inWindow = all.filter((a) => within(a.submitted_at, w));
      const passed = inWindow.filter((a) => Number(a.is_passed) === 1);
      const bins = [0, 0, 0, 0, 0];
      for (const a of inWindow) {
        const p = Number(a.percentage);
        bins[p < 60 ? 0 : p < 70 ? 1 : p < 80 ? 2 : p < 90 ? 3 : 4]++;
      }
      return cap({
        key: type,
        title: 'Assessment results',
        kpis: [
          { label: 'Attempts', value: String(inWindow.length) },
          { label: 'Passed', value: String(passed.length) },
          { label: 'Pass rate', value: `${percent(passed.length, inWindow.length)}%` },
          { label: 'Avg score', value: `${avg(inWindow.map((a) => Number(a.percentage)))}%` },
        ],
        columns: ['Learner', 'Department', 'Course', 'Assessment', 'Score', 'Result', 'Submitted'],
        rows: inWindow
          .sort((a, b) => Number(b.percentage) - Number(a.percentage))
          .map((a) => [
            `${a.first_name} ${a.last_name}`,
            a.department ?? '—',
            a.course_name,
            a.assessment_title,
            `${Math.round(Number(a.percentage))}%`,
            Number(a.is_passed) === 1 ? 'Pass' : 'Fail',
            a.submitted_at.slice(0, 10),
          ]),
        chart: {
          labels: ['Below 60', '60–69', '70–79', '80–89', '90–100'],
          data: bins,
          axisLabel: 'Attempts',
        },
        totalRows: inWindow.length,
      }, full);
    }

    if (type === 'attendance') {
      const rows = await this.repository.attendanceBySession(scope, w);
      const enrolled = rows.reduce((a, r) => a + Number(r.enrolled), 0);
      const present = rows.reduce((a, r) => a + Number(r.present), 0);
      return cap({
        key: type,
        title: 'Session attendance',
        kpis: [
          { label: 'Sessions', value: String(rows.length) },
          { label: 'Total enrolled', value: String(enrolled) },
          { label: 'Total present', value: String(present) },
          { label: 'Attendance rate', value: `${percent(present, enrolled)}%` },
        ],
        columns: ['Session', 'Trainer', 'Date', 'Enrolled', 'Present', 'Attendance'],
        rows: rows.map((r) => [
          r.title,
          r.trainer ?? '—',
          r.date.slice(0, 10),
          Number(r.enrolled),
          Number(r.present),
          `${percent(Number(r.present), Number(r.enrolled))}%`,
        ]),
        chart: {
          labels: rows.map((r) => r.title),
          data: rows.map((r) => percent(Number(r.present), Number(r.enrolled))),
          axisLabel: 'Attendance %',
        },
        totalRows: rows.length,
      }, full);
    }

    if (type === 'trainer') {
      const sessions = await this.repository.attendanceBySession(scope, w);
      const by = new Map<string, { sessions: number; enrolled: number; present: number }>();
      for (const s of sessions) {
        const key = s.trainer ?? 'Unassigned';
        const g = by.get(key) ?? { sessions: 0, enrolled: 0, present: 0 };
        g.sessions++;
        g.enrolled += Number(s.enrolled);
        g.present += Number(s.present);
        by.set(key, g);
      }
      const rows = [...by.entries()].sort((a, b) => b[1].sessions - a[1].sessions);
      return cap({
        key: type,
        title: 'Trainer delivery',
        kpis: [
          { label: 'Trainers', value: String(rows.length) },
          { label: 'Sessions delivered', value: String(rows.reduce((a, [, g]) => a + g.sessions, 0)) },
          { label: 'Learners reached', value: String(rows.reduce((a, [, g]) => a + g.enrolled, 0)) },
          {
            label: 'Attendance rate',
            value: `${percent(
              rows.reduce((a, [, g]) => a + g.present, 0),
              rows.reduce((a, [, g]) => a + g.enrolled, 0),
            )}%`,
          },
        ],
        columns: ['Trainer', 'Sessions', 'Learners', 'Present', 'Attendance'],
        rows: rows.map(([t, g]) => [t, g.sessions, g.enrolled, g.present, `${percent(g.present, g.enrolled)}%`]),
        chart: {
          labels: rows.map(([t]) => t),
          data: rows.map(([, g]) => g.sessions),
          axisLabel: 'Sessions',
        },
        totalRows: rows.length,
      }, full);
    }

    return null;
  }

  // ═══════════════════════════ DASHBOARD ═══════════════════════════════

  /** Learners who need chasing, shaped for the dashboard panel. */
  async actionRequired(scope: OrgScope) {
    const rows = await this.repository.actionRequired(scope, STALE_DAYS);
    return rows.map((r) => {
      const failed =
        r.best_score !== null && Number(r.best_score) < Number(r.passing_score ?? 60);
      const notStarted = Number(r.completed_lessons) === 0;
      return {
        user_id: r.user_id,
        name: `${r.first_name} ${r.last_name}`,
        department: r.department,
        course_id: r.course_id,
        course_name: r.course_name,
        progress: percent(r.completed_lessons, r.total_lessons),
        kind: failed ? 'failed' : notStarted ? 'not-started' : 'stalled',
        reason: failed
          ? `Failed the assessment · ${Math.round(Number(r.best_score))}%`
          : notStarted
            ? 'Has not started their course'
            : `No activity for ${STALE_DAYS}+ days · ${percent(r.completed_lessons, r.total_lessons)}% complete`,
        action: failed ? 'Reassign' : notStarted ? 'Send nudge' : 'Remind',
      };
    });
  }
}

// ── small helpers, deliberately not methods: no state, no scope ──────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function percent(part: number, whole: number): number {
  const p = Number(part);
  const w = Number(whole);
  return w > 0 ? Math.round((p / w) * 100) : 0;
}

function avg(values: number[]): number {
  const clean = values.filter((v) => Number.isFinite(v));
  return clean.length ? Math.round(clean.reduce((a, v) => a + v, 0) / clean.length) : 0;
}

function isComplete(a: CompletionFilterRow): boolean {
  return Number(a.total_lessons) > 0 && Number(a.completed_lessons) >= Number(a.total_lessons);
}

function statusOf(a: CompletionFilterRow): string {
  if (isComplete(a)) return 'Completed';
  return Number(a.completed_lessons) > 0 ? 'In progress' : 'Not started';
}

function within(date: string | null, w: { from: string; to: string }): boolean {
  if (!date) return false;
  const d = date.slice(0, 10);
  return d >= w.from && d <= w.to;
}

/**
 * Applies the row cap AFTER the KPIs, so the summary still describes it all.
 *
 * `full` skips it entirely, and only the .xlsx export passes it. The cap
 * exists so a browser is not asked to lay out 20,000 table rows; a spreadsheet
 * has no such problem, and a download that silently stopped at row 500 while
 * its own KPI block described the whole population would be the worst version
 * of this — wrong, and wrong in a file that leaves the building.
 */
function cap(report: BuiltReport, full = false): BuiltReport {
  if (full || report.rows.length <= ROW_CAP) return report;
  return { ...report, rows: report.rows.slice(0, ROW_CAP), truncated: true };
}
