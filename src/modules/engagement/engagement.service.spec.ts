import { EngagementService, learnerSeries } from './engagement.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as any;
const pt = (period: string, label: string, total: number) =>
  ({ period, label, course: total, path: 0, session: 0, total }) as any;

describe('learnerSeries', () => {
  it('charts engaged time for a learner with no learning hours (empty learning axis)', () => {
    const series = learnerSeries([], new Map([['2026-11-16', 1800]]), 'weekly');
    expect(series).toEqual([
      { period: '2026-11-16', label: '16 Nov', learningHours: 0, engagementHours: 0.5 },
    ]);
  });

  it('unions both axes, keeping the learning labels and zero-filled gaps', () => {
    const axis = [pt('2026-11-02', '2 Nov', 60), pt('2026-11-09', '9 Nov', 0), pt('2026-11-16', '16 Nov', 12)];
    const series = learnerSeries(axis, new Map([['2026-11-16', 1800], ['2026-10-26', 3600]]), 'weekly');
    expect(series.map((p) => p.period)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
    expect(series[0]).toEqual({ period: '2026-10-26', label: '26 Oct', learningHours: 0, engagementHours: 1 });
    // Engagement is floored at learning (1h learning, no tracked time).
    expect(series[1]).toEqual({ period: '2026-11-02', label: '2 Nov', learningHours: 1, engagementHours: 1 });
    expect(series[3]).toEqual({ period: '2026-11-16', label: '16 Nov', learningHours: 0.2, engagementHours: 0.5 });
  });

  it('caps the union to the most recent buckets of the granularity', () => {
    const eng = new Map<string, number>();
    for (let m = 1; m <= 12; m++) eng.set(`2026-${String(m).padStart(2, '0')}-01`, 3600);
    const axis = [pt('2025-12-01', "Dec '25", 60)];
    const series = learnerSeries(axis, eng, 'monthly');
    expect(series).toHaveLength(12);
    expect(series[0].period).toBe('2026-01-01');
  });
});

describe('EngagementService.learnerTrend', () => {
  it('returns engaged periods and totals when learning hours are empty', async () => {
    const repository = { learnerByPeriod: jest.fn().mockResolvedValue([{ period: '2026-11-16', seconds: 1800 }]) };
    const hours = {
      learnerHoursTrend: jest.fn().mockResolvedValue({ weekly: [], monthly: [], quarterly: [], yearly: [] }),
    };
    const svc = new EngagementService(repository as any, hours as any);
    const trend = await svc.learnerTrend(scope, 10, 'weekly');
    expect(repository.learnerByPeriod).toHaveBeenCalledWith(scope, 10, 'week');
    expect(trend.series).toHaveLength(1);
    expect(trend.totals).toEqual({ learningHours: 0, engagementHours: 0.5 });
  });
});
