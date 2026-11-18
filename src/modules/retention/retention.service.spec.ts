import { PURGE_CATEGORIES, RetentionService } from './retention.service';

function makeConfig(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as any;
}

function makeRepo(overrides: Partial<Record<string, any>> = {}) {
  return {
    organizationsDueForDeletion: jest.fn().mockResolvedValue([]),
    countUsersOfOrganization: jest.fn().mockResolvedValue(0),
    usersOfOrganization: jest.fn().mockResolvedValue([]),
    purgeOrganization: jest.fn().mockResolvedValue({ files: [] }),
    countAnonymizationCandidates: jest.fn().mockResolvedValue(0),
    findAnonymizationCandidates: jest.fn().mockResolvedValue([]),
    anonymizeUser: jest.fn().mockResolvedValue({ avatars: [], shared: [], certificates: [] }),
    countDue: jest.fn().mockResolvedValue(0),
    purgeBatch: jest.fn().mockResolvedValue({ deleted: 0, files: [] }),
    countDueCertificateFiles: jest.fn().mockResolvedValue(0),
    releaseDueCertificateFiles: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

const files = () => ({ remove: jest.fn().mockResolvedValue(0) }) as any;
const on = (dryRun: boolean, extra: Record<string, unknown> = {}) =>
  makeConfig({ 'retention.enabled': true, 'retention.dryRun': dryRun, 'retention.deactivatedUserDays': 365, ...extra });

describe('RetentionService.sweep', () => {
  it('does nothing when disabled (the default) and never touches the repo', async () => {
    const repo = makeRepo();
    const res = await new RetentionService(makeConfig({ 'retention.enabled': false }), repo, files()).sweep();
    expect(res).toMatchObject({ enabled: false, anonymized: 0 });
    expect(repo.countAnonymizationCandidates).not.toHaveBeenCalled();
    expect(repo.anonymizeUser).not.toHaveBeenCalled();
    expect(repo.purgeBatch).not.toHaveBeenCalled();
  });

  it('in dry-run counts every job and changes nothing', async () => {
    const repo = makeRepo({
      organizationsDueForDeletion: jest.fn().mockResolvedValue([{ id: 9, name: 'Leaver Ltd' }]),
      countUsersOfOrganization: jest.fn().mockResolvedValue(40),
      countAnonymizationCandidates: jest.fn().mockResolvedValue(7),
      countDue: jest.fn().mockResolvedValue(3),
    });
    const res = await new RetentionService(on(true), repo, files()).sweep();
    expect(res).toMatchObject({ dryRun: true, candidates: 7, anonymized: 0 });
    expect(res.organizations).toEqual([{ id: 9, name: 'Leaver Ltd', people: 40 }]);
    expect(res.purged.audit_log).toBe(3);
    expect(repo.anonymizeUser).not.toHaveBeenCalled();
    expect(repo.purgeOrganization).not.toHaveBeenCalled();
    expect(repo.purgeBatch).not.toHaveBeenCalled();
    expect(repo.releaseDueCertificateFiles).not.toHaveBeenCalled();
  });

  it('anonymises each due person and deletes the files released', async () => {
    const repo = makeRepo({
      countAnonymizationCandidates: jest.fn().mockResolvedValue(2),
      findAnonymizationCandidates: jest.fn().mockResolvedValueOnce([1, 2]).mockResolvedValueOnce([]),
      anonymizeUser: jest.fn().mockResolvedValue({ avatars: ['/uploads/avatars/x.png'], shared: [], certificates: [] }),
    });
    const f = files();
    const res = await new RetentionService(on(false), repo, f).sweep();
    expect(res.anonymized).toBe(2);
    expect(repo.anonymizeUser).toHaveBeenCalledWith(1);
    expect(repo.anonymizeUser).toHaveBeenCalledWith(2);
    expect(f.remove).toHaveBeenCalledWith({ avatars: ['/uploads/avatars/x.png'], shared: [], certificates: [] });
  });

  it('offboards a due organization: everyone anonymised, then its content purged', async () => {
    const repo = makeRepo({
      organizationsDueForDeletion: jest.fn().mockResolvedValue([{ id: 9, name: 'Leaver Ltd' }]),
      countUsersOfOrganization: jest.fn().mockResolvedValue(2),
      usersOfOrganization: jest.fn().mockResolvedValueOnce([5, 6]).mockResolvedValueOnce([]),
    });
    await new RetentionService(on(false), repo, files()).sweep();
    expect(repo.anonymizeUser).toHaveBeenCalledWith(5);
    expect(repo.anonymizeUser).toHaveBeenCalledWith(6);
    expect(repo.purgeOrganization).toHaveBeenCalledWith(9);
    const anonOrder = repo.anonymizeUser.mock.invocationCallOrder[1];
    expect(repo.purgeOrganization.mock.invocationCallOrder[0]).toBeGreaterThan(anonOrder);
  });

  it('applies the owner-approved time limits: audit log 365 days, read notifications 180', async () => {
    const repo = makeRepo();
    await new RetentionService(
      on(true, { 'retention.days': { audit_log: 365, notifications_read: 180 } }),
      repo,
      files(),
    ).sweep();
    expect(repo.countDue).toHaveBeenCalledWith('audit_log', 365);
    expect(repo.countDue).toHaveBeenCalledWith('notifications_read', 180);
    expect(repo.countDue).toHaveBeenCalledTimes(PURGE_CATEGORIES.length);
  });

  it('keeps purging a category in batches until nothing is left', async () => {
    const purgeBatch = jest.fn()
      .mockResolvedValueOnce({ deleted: 5000, files: [] })
      .mockResolvedValueOnce({ deleted: 12, files: [] })
      .mockResolvedValue({ deleted: 0, files: [] });
    const repo = makeRepo({ purgeBatch });
    const res = await new RetentionService(on(false), repo, files()).sweep();
    expect(res.purged.audit_log).toBe(5012);
  });
});
