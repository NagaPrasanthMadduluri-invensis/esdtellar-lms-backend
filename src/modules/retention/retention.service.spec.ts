import { RetentionService } from './retention.service';

function makeConfig(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as any;
}

function makeRepo(overrides: Partial<Record<string, any>> = {}) {
  return {
    countAnonymizationCandidates: jest.fn().mockResolvedValue(0),
    findAnonymizationCandidates: jest.fn().mockResolvedValue([]),
    anonymize: jest.fn().mockResolvedValue(0),
    ...overrides,
  } as any;
}

describe('RetentionService.sweep', () => {
  it('does nothing when disabled (the default) and never touches the repo', async () => {
    const repo = makeRepo();
    const svc = new RetentionService(makeConfig({ 'retention.enabled': false }), repo);

    const res = await svc.sweep();

    expect(res).toMatchObject({ enabled: false, anonymized: 0 });
    expect(repo.countAnonymizationCandidates).not.toHaveBeenCalled();
    expect(repo.anonymize).not.toHaveBeenCalled();
  });

  it('counts but never anonymises in dry-run', async () => {
    const repo = makeRepo({
      countAnonymizationCandidates: jest.fn().mockResolvedValue(7),
    });
    const svc = new RetentionService(
      makeConfig({
        'retention.enabled': true,
        'retention.dryRun': true,
        'retention.deactivatedUserDays': 365,
      }),
      repo,
    );

    const res = await svc.sweep();

    expect(res).toMatchObject({ enabled: true, dryRun: true, candidates: 7, anonymized: 0 });
    expect(repo.anonymize).not.toHaveBeenCalled();
  });

  it('anonymises in batches when enabled and not dry-run', async () => {
    const repo = makeRepo({
      countAnonymizationCandidates: jest.fn().mockResolvedValue(3),
      findAnonymizationCandidates: jest
        .fn()
        .mockResolvedValueOnce([1, 2, 3])
        .mockResolvedValueOnce([]), // second pass drains the queue
      anonymize: jest.fn().mockResolvedValue(3),
    });
    const svc = new RetentionService(
      makeConfig({
        'retention.enabled': true,
        'retention.dryRun': false,
        'retention.deactivatedUserDays': 365,
      }),
      repo,
    );

    const res = await svc.sweep();

    expect(res).toMatchObject({ enabled: true, dryRun: false, anonymized: 3 });
    expect(repo.anonymize).toHaveBeenCalledWith([1, 2, 3]);
    expect(repo.anonymize).toHaveBeenCalledTimes(1);
  });

  it('computes the cutoff from the configured window', async () => {
    const repo = makeRepo();
    const svc = new RetentionService(
      makeConfig({
        'retention.enabled': true,
        'retention.dryRun': true,
        'retention.deactivatedUserDays': 30,
      }),
      repo,
    );

    await svc.sweep();

    const cutoff = new Date(repo.countAnonymizationCandidates.mock.calls[0][0]);
    const daysAgo = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(29.9);
    expect(daysAgo).toBeLessThan(30.1);
  });
});
