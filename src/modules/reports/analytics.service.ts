import { Injectable } from '@nestjs/common';

import { LeaderboardService } from '@/modules/leaderboard/leaderboard.service';
import type { OrgScope } from '@/database/org-scope';

import { LearningHoursService } from '@/modules/learning-hours/learning-hours.service';

import {
  AnalyticsRepository,
  type LearnerStatsRow,
} from './analytics.repository';

/**
 * The analytics pages are pinned to a fixed reference month because the seed
 * data lives in June 2026 — a live `new Date()` would render empty charts.
 * Carried over from the legacy handlers verbatim; change it here only, and
 * only when the data stops being seed data.
 */
const REFERENCE_DATE = new Date('2026-06-15');
const MONTHLY_GOAL_HOURS = 10;
const WEEKS = ['W1', 'W2', 'W3', 'W4'] as const;

type LearnerStatus = 'completed' | 'failed' | 'in-progress' | 'not-started';

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function minutesToHours(minutes: number): number {
  return Math.round((Number(minutes) / 60) * 10) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Time spent, for a spreadsheet cell.
 *
 * "N/A" when nothing was recorded — the learner has not started, and a bare 0
 * would read as a measurement rather than an absence. Anything under an hour
 * stays in minutes; there is no value in "0h 12m".
 */
function formatTimeSpent(minutes: number): string {
  const total = Math.round(minutes);
  if (total <= 0) return 'N/A';
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

@Injectable()
export class AnalyticsService {
  private readonly thisMonth = monthKey(REFERENCE_DATE);
  private readonly lastMonth = monthKey(
    new Date(REFERENCE_DATE.getFullYear(), REFERENCE_DATE.getMonth() - 1, 1),
  );

  constructor(
    private readonly repository: AnalyticsRepository,
    private readonly hours: LearningHoursService,
    private readonly leaderboard_: LeaderboardService,
  ) {}

  /**
   * Per-learner minutes from the shared calculation.
   *
   * The admin figures used to come from this module's own SUM of
   * `lessons.duration_minutes`, which counted no SCORM time at all and no
   * measured video time — so the same learner read differently here than on
   * their own dashboard. Both sides now read LearningHoursService, and there is
   * one definition of an hour rather than two.
   */
  private async minutes(scope: OrgScope) {
    return this.hours.minutesByUser(scope);
  }

  /** Shared status rule — identical across every analytics endpoint. */
  private statusOf(row: LearnerStatsRow): LearnerStatus {
    if (Number(row.has_passed) === 1) return 'completed';
    if (Number(row.attempt_count) > 0) return 'failed';
    if (Number(row.completed_lessons) > 0) return 'in-progress';
    return 'not-started';
  }

  private stats(scope: OrgScope) {
    return this.repository.learnerStats(scope, this.thisMonth, this.lastMonth);
  }

  async dashboard(scope: OrgScope) {
    const [counts, recentUsers, recentAttempts] = await Promise.all([
      this.repository.dashboardCounts(scope),
      this.repository.recentUsers(scope),
      this.repository.recentAttempts(scope),
    ]);

    return {
      stats: {
        totalCourses: Number(counts.total_courses),
        totalUsers: Number(counts.total_users),
        totalAssigned: Number(counts.total_assigned),
        totalCompleted: Number(counts.total_completed),
      },
      recentUsers,
      recentAttempts,
    };
  }

  async reports(scope: OrgScope) {
    const minutesByUser = await this.minutes(scope);
    const [rows, activeCourses, overdueCourses] = await Promise.all([
      this.stats(scope),
      this.repository.activeCourseCount(scope),
      this.repository.overdueCourseCount(scope),
    ]);

    const learners = rows.map((row) => ({
      ...row,
      status: this.statusOf(row),
      score: row.best_score !== null ? Math.round(Number(row.best_score)) : null,
    }));

    const counts = { completed: 0, inProgress: 0, notStarted: 0, failed: 0 };
    for (const learner of learners) {
      if (learner.status === 'completed') counts.completed++;
      else if (learner.status === 'failed') counts.failed++;
      else if (learner.status === 'in-progress') counts.inProgress++;
      else counts.notStarted++;
    }

    const scores = learners
      .map((learner) => learner.score)
      .filter((score): score is number => score !== null);

    const total = learners.length;
    const avgScore = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

    const bins = [0, 0, 0, 0, 0];
    for (const score of scores) {
      if (score < 60) bins[0]++;
      else if (score < 70) bins[1]++;
      else if (score < 80) bins[2]++;
      else if (score < 90) bins[3]++;
      else bins[4]++;
    }

    const departments = [
      ...new Set(learners.map((l) => l.department).filter(Boolean)),
    ].sort() as string[];

    const deptCompletion = departments.map((dept) => {
      const members = learners.filter((l) => l.department === dept);
      const deptTotal = members.length;
      const deptCompleted = members.filter((l) => l.status === 'completed').length;
      const deptInProgress = members.filter((l) => l.status === 'in-progress').length;
      const deptScores = members
        .map((l) => l.score)
        .filter((s): s is number => s !== null);
      const totalMinutes = members.reduce(
        (sum, l) => sum + (minutesByUser.get(Number(l.id))?.all ?? 0),
        0,
      );

      return {
        dept,
        total: deptTotal,
        completed: deptCompleted,
        in_progress: deptInProgress,
        pct: deptTotal ? Math.round((deptCompleted / deptTotal) * 100) : 0,
        in_progress_pct: deptTotal
          ? Math.round((deptInProgress / deptTotal) * 100)
          : 0,
        hours_learning: minutesToHours(totalMinutes),
        avg_score: deptScores.length
          ? Math.round(deptScores.reduce((a, b) => a + b, 0) / deptScores.length)
          : null,
      };
    });

    return {
      stats: {
        total,
        completed: counts.completed,
        inProgress: counts.inProgress,
        notStarted: counts.notStarted,
        failed: counts.failed,
        compRate: total ? Math.round((counts.completed / total) * 100) : 0,
        avgScore,
        passRate: scores.length
          ? Math.round(
              (scores.filter((s) => s >= 60).length / scores.length) * 100,
            )
          : 0,
        activeCourses,
        overdueCourses,
      },
      statusBreakdown: [
        { status: 'Completed', value: counts.completed },
        { status: 'In Progress', value: counts.inProgress },
        { status: 'Not Started', value: counts.notStarted },
        { status: 'Failed', value: counts.failed },
      ],
      scoreBins: [
        { range: 'Below 60', count: bins[0] },
        { range: '60–69', count: bins[1] },
        { range: '70–79', count: bins[2] },
        { range: '80–89', count: bins[3] },
        { range: '90–100', count: bins[4] },
      ],
      deptCompletion,
      topScorers: learners
        .filter((l) => l.score !== null)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 5)
        .map((l) => ({
          id: l.id,
          name: `${l.first_name} ${l.last_name}`,
          score: l.score,
          department: l.department,
          job_role: l.job_role ?? null,
          location: l.location ?? null,
        })),
      needsAttention: learners
        .filter((l) => l.status === 'not-started')
        .map((l) => ({
          id: l.id,
          name: `${l.first_name} ${l.last_name}`,
          department: l.department,
          job_role: l.job_role ?? null,
          location: l.location ?? null,
        })),
    };
  }

  async departments(scope: OrgScope) {
    const rows = await this.stats(scope);

    const names = [
      ...new Set(rows.map((r) => r.department).filter(Boolean)),
    ].sort() as string[];

    return {
      departments: names.map((dept) => {
        const members = rows.filter((r) => r.department === dept);
        let completed = 0;
        let inProgress = 0;
        let notStarted = 0;
        let failed = 0;
        const scores: number[] = [];

        for (const member of members) {
          const status = this.statusOf(member);
          if (status === 'completed') {
            completed++;
            if (member.best_score !== null) scores.push(Number(member.best_score));
          } else if (status === 'failed') {
            failed++;
            if (member.best_score !== null) scores.push(Number(member.best_score));
          } else if (status === 'in-progress') {
            inProgress++;
          } else {
            notStarted++;
          }
        }

        const total = members.length;
        return {
          dept,
          total,
          completed,
          in_progress: inProgress,
          not_started: notStarted,
          failed,
          avg_score: scores.length
            ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
            : null,
          completion_pct: total ? Math.round((completed / total) * 100) : 0,
        };
      }),
    };
  }

  /**
   * Admin standings.
   *
   * Ranked by the SAME points calculation the learner board uses — previously
   * this blended completion and hours 60/40, so the two boards could disagree
   * about who was first. Hours and completion are still shown as columns,
   * because they are useful to an admin, but they no longer decide the order.
   */
  async leaderboard(scope: OrgScope) {
    const [{ byPoints, recognition }, statRows, minutesByUser] = await Promise.all([
      this.leaderboard_.standings(scope),
      this.stats(scope),
      this.minutes(scope),
    ]);

    const statsById = new Map(statRows.map((r) => [Number(r.id), r]));

    const ranked = byPoints.map((entry) => {
      const row = statsById.get(entry.id);
      const assigned = Number(row?.assigned_lessons ?? 0);
      const completed = Number(row?.completed_lessons ?? 0);

      return {
        id: entry.id,
        name: entry.name,
        dept: entry.dept,
        job_role: row?.job_role ?? null,
        location: row?.location ?? null,
        rank: entry.rank,
        // `score` stays the field the table sorts and bars on — it is points now.
        score: entry.points,
        points: entry.points,
        monthPoints: entry.monthPoints,
        badges: entry.badges,
        attempts: entry.attempts,
        avgScore: entry.avgScore,
        thisMonth: minutesToHours(minutesByUser.get(entry.id)?.thisMonth ?? 0),
        allTime: minutesToHours(minutesByUser.get(entry.id)?.all ?? 0),
        completionPct: assigned > 0 ? Math.round((completed / assigned) * 100) : 0,
        assessScore: Number(row?.best_score ?? 0),
      };
    });

    const totalLearners = ranked.length;

    return {
      stats: {
        totalLearners,
        avgHours: totalLearners
          ? round1(ranked.reduce((sum, l) => sum + l.thisMonth, 0) / totalLearners)
          : 0,
        avgCompletion: totalLearners
          ? Math.round(
              ranked.reduce((sum, l) => sum + l.completionPct, 0) / totalLearners,
            )
          : 0,
        topName: ranked[0]?.name ?? '',
        topDept: ranked[0]?.dept ?? '',
      },
      recognition,
      learners: ranked,
    };
  }

  async learningHours(scope: OrgScope) {
    const [rows, weeklyRaw, enrollmentRows, completionRows, minutesByUser] =
      await Promise.all([
      this.stats(scope),
      this.repository.weeklyHoursByDepartment(scope, this.thisMonth),
      this.repository.weeklyEnrollments(scope, this.thisMonth),
      this.repository.weeklyCompletions(scope, this.thisMonth),
      this.minutes(scope),
    ]);

    const learners = rows
      .map((row) => {
        const mine = minutesByUser.get(Number(row.id));
        const thisMonth = minutesToHours(mine?.thisMonth ?? 0);
        const progressPct = Math.min(
          Math.round((thisMonth / MONTHLY_GOAL_HOURS) * 100),
          150,
        );

        return {
          id: row.id,
          name: `${row.first_name} ${row.last_name}`,
          dept: row.department,
          job_role: row.job_role ?? null,
          location: row.location ?? null,
          thisMonth,
          lastMonth: minutesToHours(mine?.lastMonth ?? 0),
          goal: MONTHLY_GOAL_HOURS,
          progressPct,
          allTime: minutesToHours(mine?.all ?? 0),
          status:
            progressPct >= 100 ? 'On Track' : progressPct >= 60 ? 'Close' : 'Behind',
        };
      })
      .sort((a, b) => b.thisMonth - a.thisMonth);

    const deptNames = [
      ...new Set(learners.map((l) => l.dept).filter(Boolean)),
    ].sort() as string[];

    const departments = deptNames.map((dept) => {
      const members = learners.filter((l) => l.dept === dept);
      const totalHours = round1(
        members.reduce((sum, l) => sum + l.thisMonth, 0),
      );
      return {
        dept,
        totalHours,
        learners: members.length,
        avgHours: members.length ? round1(totalHours / members.length) : 0,
        onTrack: members.filter((l) => l.status === 'On Track').length,
      };
    });

    const trendByWeek = new Map<string, Record<string, string | number>>();
    for (const row of weeklyRaw) {
      const entry = trendByWeek.get(row.week) ?? { week: row.week };
      entry[row.dept] = Number(row.hrs);
      trendByWeek.set(row.week, entry);
    }

    const activity = new Map(
      WEEKS.map((week) => [
        week as string,
        { week, Enrollments: 0, Completions: 0 },
      ]),
    );
    for (const row of enrollmentRows) {
      const entry = activity.get(row.week);
      if (entry) entry.Enrollments = Number(row.cnt);
    }
    for (const row of completionRows) {
      const entry = activity.get(row.week);
      if (entry) entry.Completions = Number(row.cnt);
    }

    const totalHours = round1(
      learners.reduce((sum, l) => sum + l.thisMonth, 0),
    );

    return {
      stats: {
        totalHours,
        avgPerLearner: learners.length
          ? round1(totalHours / learners.length)
          : 0,
        onTrack: learners.filter((l) => l.status === 'On Track').length,
        behindGoal: learners.filter((l) => l.status === 'Behind').length,
      },
      departments,
      weeklyTrend: WEEKS.map((week) => trendByWeek.get(week) ?? { week }),
      weeklyActivity: WEEKS.map((week) => activity.get(week)),
      learners,
    };
  }

  /** Row data for the four export sheets. */
  async exportRows(scope: OrgScope) {
    const [rows, courseRows, topScorers, courseMinutes] = await Promise.all([
      this.stats(scope),
      this.repository.courseProgressPerLearner(scope),
      this.repository.topScorers(scope, 20),
      // "Time Spent" was a literal em dash on every row. It comes from the same
      // calculation as every other hours figure, so the report agrees with the
      // dashboards instead of inventing a fourth number.
      this.hours.minutesByUserAndCourse(scope),
    ]);

    const byLearner = new Map<number, typeof courseRows>();
    for (const row of courseRows) {
      const key = Number(row.user_id);
      const list = byLearner.get(key);
      if (list) list.push(row);
      else byLearner.set(key, [row]);
    }

    const progressRows: (string | number | null)[][] = [];
    const assignRows: (string | number | null)[][] = [];
    let seq = 1;

    for (const learner of rows) {
      const employeeId = `EDS-${String(learner.id).padStart(3, '0')}`;
      const fullName = `${learner.first_name} ${learner.last_name}`;
      const dept = learner.department || '—';
      const courses = byLearner.get(Number(learner.id)) ?? [];

      if (courses.length === 0) {
        progressRows.push([seq++, employeeId, fullName, dept, '—', learner.email,
          '—', '—', '—', 'Not Started', 0, 'N/A', 'N/A', 'N/A']);
        assignRows.push([employeeId, fullName, dept, '—', '—', '—', '—', 'Not Started', '—']);
        continue;
      }

      for (const course of courses) {
        const total = Number(course.total_lessons);
        const completed = Number(course.completed_lessons);
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
        const attemptCount = Number(course.attempt_count);
        const hasPassed = Number(course.has_passed) === 1;

        let status: string;
        if (hasPassed) status = 'Completed';
        else if (attemptCount > 0) status = 'Failed';
        else if (completed > 0) status = 'In Progress';
        else status = 'Not Started';

        const assignedDate = this.formatDate(course.assigned_at);

        progressRows.push([
          seq++, employeeId, fullName, dept, '—', learner.email,
          course.course_name, assignedDate, '—', status, progress,
          // "N/A" rather than an em dash, so the two assessment columns agree
          // with each other about what "no attempt yet" looks like.
          course.best_score !== null ? Number(course.best_score) : 'N/A',
          attemptCount === 0 ? 'N/A' : hasPassed ? 'Pass ✓' : 'Fail ✗',
          formatTimeSpent(
            courseMinutes.get(`${learner.id}:${course.course_id}`) ?? 0,
          ),
        ]);

        assignRows.push([
          employeeId, fullName, dept, '—', course.course_name,
          assignedDate, '—', status, '—',
        ]);
      }
    }

    /* Department sheet, plus an organisation total row. */
    const deptNames = [
      ...new Set(rows.map((r) => r.department).filter(Boolean)),
    ].sort() as string[];

    const deptRows: (string | number | null)[][] = [];
    let orgTotal = 0;
    let orgCompleted = 0;
    let orgInProgress = 0;
    let orgOther = 0;
    let orgScoreSum = 0;
    let orgScoreCount = 0;

    for (const dept of deptNames) {
      const members = rows.filter((r) => r.department === dept);
      let completed = 0;
      let inProgress = 0;
      let other = 0;
      let scoreSum = 0;
      let scoreCount = 0;

      for (const member of members) {
        const status = this.statusOf(member);
        if (status === 'completed') {
          completed++;
          if (member.best_score !== null) {
            scoreSum += Number(member.best_score);
            scoreCount++;
          }
        } else if (status === 'in-progress') inProgress++;
        else other++;
      }

      const total = members.length;
      deptRows.push([
        dept, '—', total, completed, inProgress, other,
        total > 0 ? Number(((completed / total) * 100).toFixed(1)) : 0,
        scoreCount > 0 ? Number((scoreSum / scoreCount).toFixed(1)) : '—',
      ]);

      orgTotal += total;
      orgCompleted += completed;
      orgInProgress += inProgress;
      orgOther += other;
      orgScoreSum += scoreSum;
      orgScoreCount += scoreCount;
    }

    deptRows.push([
      'ORGANISATION TOTAL', null, orgTotal, orgCompleted, orgInProgress, orgOther,
      orgTotal > 0 ? Number(((orgCompleted / orgTotal) * 100).toFixed(1)) : 0,
      orgScoreCount > 0 ? Number((orgScoreSum / orgScoreCount).toFixed(1)) : '—',
    ]);

    const medals = ['🥇', '🥈', '🥉'];
    const leaderRows = topScorers.map((scorer, index) => [
      index < 3 ? medals[index] : String(index + 1),
      `EDS-${String(scorer.id).padStart(3, '0')}`,
      `${scorer.first_name} ${scorer.last_name}`,
      scorer.department || '—',
      Number(scorer.best_score),
      this.grade(Number(scorer.best_score)),
    ]);

    return { progressRows, deptRows, leaderRows, assignRows };
  }

  private formatDate(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  }

  private grade(score: number | null): string {
    if (score === null) return '—';
    if (score >= 90) return 'A+';
    if (score >= 80) return 'A';
    if (score >= 70) return 'B';
    if (score >= 60) return 'C';
    return 'F';
  }
}
