import { AdminInsightsService } from './admin-insights.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as any;

function dashboard() {
  return {
    headline: { totalLearners: 40, activeLearners: 28, completionRate: 62, inProgress: 15, overdue: 9 },
    engagement: { avgScore: 74, passRate: 81, totalHours: 320, hoursThisMonth: 44, certificatesIssued: 18, activeCourses: 12 },
    statusBreakdown: [{ status: 'Completed', value: 20 }, { status: 'In Progress', value: 15 }],
    deptCompletion: [
      { dept: 'Engineering', total: 20, pct: 71, hours_learning: 120 },
      { dept: 'Sales', total: 3, pct: 40, hours_learning: 60 }, // below the k-anon floor
    ],
    insights: [
      { text: 'Overall completion is 62% across 40 learners.' },
      { text: 'Engineering leads at 71%; Sales is furthest behind at 40% and may need a nudge.' },
    ],
  };
}

function deps(enabled: boolean) {
  const ai = {
    isEnabled: jest.fn().mockReturnValue(enabled),
    generateJson: jest.fn().mockResolvedValue({ summary: 'ok', patterns: [], risks: [], recommendations: [], wins: [] }),
    storeInsight: jest.fn().mockResolvedValue(undefined),
    getInsight: jest.fn().mockResolvedValue({ payload: { summary: 'ok' }, generated_at: 't', model: 'm' }),
  };
  const repository = {
    lowRatedCourses: jest.fn().mockResolvedValue([{ name: 'Course C', avg_rating: 2.3, responses: 7 }]),
    lowRatedSessions: jest.fn().mockResolvedValue([]),
  };
  const analytics = { dashboard: jest.fn().mockResolvedValue(dashboard()) };
  const svc = new AdminInsightsService(ai as any, repository as any, analytics as any);
  return { svc, ai, repository, analytics };
}

describe('AdminInsightsService.buildContext', () => {
  it('reuses the analytics dashboard and maps a PII-light org context', async () => {
    const { svc } = deps(true);
    const ctx = await svc.buildContext(scope);

    expect(ctx.org).toEqual({ totalLearners: 40, activeLearners: 28, completionRate: 62, inProgress: 15, overdue: 9 });
    // Engineering (20) is named; Sales (3) is below the k-anon floor and combined.
    expect(ctx.departments).toEqual([
      { dept: 'Engineering', learners: 20, completionPct: 71, hours: 120 },
      { dept: 'Smaller departments (combined)', learners: 3, completionPct: 40, hours: 60 },
    ]);
    // The signal naming the small "Sales" department is dropped; the org-level one stays.
    expect(ctx.signals).toEqual(['Overall completion is 62% across 40 learners.']);
    expect(ctx.negativeFeedback.courses).toEqual([{ name: 'Course C', avgRating: 2.3, responses: 7 }]);
  });

  it('carries no name or email in the serialised context', async () => {
    const { svc } = deps(true);
    const json = JSON.stringify(await svc.buildContext(scope)).toLowerCase();
    expect(json).not.toContain('@');
    expect(json).not.toContain('email');
  });
});

describe('AdminInsightsService generation', () => {
  it('does nothing when the feature is off', async () => {
    const { svc, ai, analytics } = deps(false);
    await expect(svc.generateForOrg(scope)).resolves.toBeNull();
    expect(analytics.dashboard).not.toHaveBeenCalled();
    expect(ai.storeInsight).not.toHaveBeenCalled();
  });

  it('stores under the org subject and org_overview kind when enabled', async () => {
    const { svc, ai } = deps(true);
    const payload = await svc.generateForOrg(scope);
    expect(payload).toMatchObject({ summary: 'ok' });
    expect(ai.storeInsight).toHaveBeenCalledWith(
      scope, 'org', 7, 'org_overview', expect.objectContaining({ summary: 'ok' }),
    );
  });

  it('refresh short-circuits when the feature is off', async () => {
    const { svc } = deps(false);
    await expect(svc.refresh(scope)).resolves.toEqual({ enabled: false, insight: null, charts: null, error: null });
  });
});
