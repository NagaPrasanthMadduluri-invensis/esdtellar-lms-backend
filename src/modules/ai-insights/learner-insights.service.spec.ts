import { LearnerInsightsService } from './learner-insights.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as any;
const DAY = 86_400_000;
const future = new Date(Date.now() + 10 * DAY).toISOString();
const past = new Date(Date.now() - 10 * DAY).toISOString();

function coursesData() {
  return {
    overview: { totalAssigned: 5, completed: 2, inProgress: 1, assigned: 1, failed: 1 },
    courses: [
      { status: 'in-progress', progressPct: 40, dueDate: future, category: 'Technical', reward: { totalPoints: 100 }, hasFailed: false, certificateId: null, course: { name: 'Course A' } },
      { status: 'completed', progressPct: 100, dueDate: past, category: 'Compliance', reward: { totalPoints: 150 }, hasFailed: false, certificateId: 7, course: { name: 'Course B' } },
      { status: 'failed', progressPct: 100, dueDate: past, category: 'Technical', reward: { totalPoints: 50 }, hasFailed: true, certificateId: null, course: { name: 'Course C' } },
      { status: 'assigned', progressPct: 0, dueDate: past, category: null, reward: { totalPoints: 80 }, hasFailed: false, certificateId: null, course: { name: 'Course D' } },
    ],
  };
}

function deps(enabled: boolean, overrides: Record<string, any> = {}) {
  const ai = {
    isEnabled: jest.fn().mockReturnValue(enabled),
    generateForTenant: jest.fn().mockResolvedValue({ summary: 'ok', priorities: [], recommendedCourses: [], nextMilestone: null, motivation: 'go' }),
    storeInsight: jest.fn().mockResolvedValue(undefined),
    getInsight: jest.fn().mockResolvedValue({ payload: { summary: 'ok' }, generated_at: 't', model: 'm' }),
    ...overrides.ai,
  };
  const repository = {
    learnerProfile: jest.fn().mockResolvedValue({ job_role: 'Engineer', job_level: 'Senior', department: 'R&D' }),
    recommendableCourses: jest.fn().mockResolvedValue([
      { name: 'Course E', category: 'Business', skills: ['Negotiation', 'Leadership'] },
    ]),
  };
  const learner = { courses: jest.fn().mockResolvedValue(coursesData()) };
  const leaderboard = {
    standings: jest.fn().mockResolvedValue({
      entries: [{ id: 10, points: 390, monthPoints: 40, completionPct: 60 }],
      ranked: [{ id: 10, rank: 2 }],
      settings: { enabled: true },
    }),
  };
  const badges = { listForLearner: jest.fn().mockResolvedValue({ next: { label: 'Fast Learner', description: 'desc', hint: 'one more' } }) };
  const competencies = { listMyCompetencies: jest.fn().mockResolvedValue([{ skill: 'Leadership', level: 'intermediate' }]) };
  const surveys = { pendingForLearner: jest.fn().mockResolvedValue({ surveys: [{ courseName: 'Course B' }] }) };
  const svc = new LearnerInsightsService(
    ai as any, repository as any, learner as any, leaderboard as any,
    badges as any, competencies as any, surveys as any,
  );
  return { svc, ai, repository };
}

describe('LearnerInsightsService.buildContext', () => {
  it('assembles a PII-light context from the canonical services', async () => {
    const { svc } = deps(true);
    const ctx = await svc.buildContext(scope, 10);

    expect(ctx.organizationId).toBe(7); // tenant fence: context is bound to the scope's org
    expect(ctx.learner).toEqual({ id: 10, jobRole: 'Engineer', jobLevel: 'Senior' });
    expect(ctx.engagement.points).toBe(390);
    expect(ctx.engagement.completionPct).toBe(60);
    expect(ctx.engagement.certificatesEarned).toBe(1);
    expect(ctx.engagement.rankLabel).toBe('#2 of 1');
    expect(ctx.inProgress.map((c) => c.name)).toEqual(['Course A']);
    expect(ctx.overdue.map((c) => c.name).sort()).toEqual(['Course C', 'Course D']);
    expect(ctx.pendingAssessments).toEqual(['Course C']);
    expect(ctx.pendingFeedback).toEqual({ count: 1, courses: ['Course B'] });
    expect(ctx.competencies.gaps).toEqual(['Negotiation']);
    expect(ctx.nearestBadge?.label).toBe('Fast Learner');
  });

  it('carries no name or email anywhere in the serialised context', async () => {
    const { svc } = deps(true);
    const ctx = await svc.buildContext(scope, 10);
    const json = JSON.stringify(ctx).toLowerCase();
    expect(json).not.toContain('@');
    expect(json).not.toContain('firstname');
    expect(json).not.toContain('email');
  });
});

describe('LearnerInsightsService.buildCharts', () => {
  it('reshapes the canonical services into a real-data chart bundle', async () => {
    const { svc } = deps(true);
    const charts = await svc.buildCharts(scope, 10);

    // Course status donut comes from the overview the canonical service computed.
    expect(charts.courseStatus).toEqual([
      { status: 'Completed', value: 2 },
      { status: 'In Progress', value: 1 },
      { status: 'Not Started', value: 1 },
      { status: 'Failed', value: 1 },
    ]);
    // Competency proficiency radar and level split, from user_skills.
    expect(charts.skillRadar).toHaveLength(1);
    expect(charts.competencyLevels).toEqual([
      { level: 'beginner', count: 0 },
      { level: 'intermediate', count: 1 },
      { level: 'advanced', count: 0 },
    ]);
    // Totals and points reused from the canonical services, never re-derived.
    expect(charts.totals).toMatchObject({ completed: 2, certificates: 1, skills: 1, badgesEarned: 0 });
    expect(charts.points).toMatchObject({ points: 390, monthPoints: 40, completionPct: 60, rankLabel: '#2 of 1' });
  });
});

describe('LearnerInsightsService generation', () => {
  it('does nothing and returns null when the feature is off', async () => {
    const { svc, ai, repository } = deps(false);
    await expect(svc.generateForLearner(scope, 10)).resolves.toBeNull();
    expect(repository.learnerProfile).not.toHaveBeenCalled();
    expect(ai.storeInsight).not.toHaveBeenCalled();
  });

  it('generates and stores under the recommendations kind when enabled', async () => {
    const { svc, ai } = deps(true);
    const payload = await svc.generateForLearner(scope, 10);
    expect(payload).toMatchObject({ summary: 'ok' });
    // Tenant fence: generation is called with the context's org, matching the scope.
    expect(ai.generateForTenant).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ contextOrgId: 7, subject: 'learner=10' }),
    );
    expect(ai.storeInsight).toHaveBeenCalledWith(
      scope, 'learner', 10, 'recommendations', expect.objectContaining({ summary: 'ok' }),
    );
  });

  it('refresh short-circuits with enabled:false when the feature is off', async () => {
    const { svc, ai } = deps(false);
    const res = await svc.refresh(scope, 10);
    expect(res).toEqual({ enabled: false, insight: null, charts: null, error: null });
    expect(ai.generateForTenant).not.toHaveBeenCalled();
  });
});
