import { CertificatesService, isVirtualSessionType } from './certificates.service';

describe('isVirtualSessionType', () => {
  it('treats Virtual and Webinar as online sittings', () => {
    expect(isVirtualSessionType('Virtual')).toBe(true);
    expect(isVirtualSessionType('Webinar')).toBe(true);
  });

  it('treats ILT and missing types as in person', () => {
    expect(isVirtualSessionType('ILT')).toBe(false);
    expect(isVirtualSessionType(null)).toBe(false);
    expect(isVirtualSessionType(undefined)).toBe(false);
  });
});


describe('CertificatesService.issueForSession (§10.66)', () => {
  const scope = { organizationId: 7, platformOrganizationId: 1 } as never;

  function make(plan: unknown, inserted?: (rows: { userId: number; certificateCode: string }[]) => unknown[]) {
    const repository = {
      sessionCertificateCandidates: jest.fn().mockResolvedValue(plan),
      findCertificatePrefix: jest.fn().mockResolvedValue(null),
      existingCodes: jest.fn().mockResolvedValue(new Set()),
      insertMany: jest.fn((_s: unknown, rows: { userId: number; certificateCode: string }[]) =>
        Promise.resolve(inserted ? inserted(rows) : rows.map((r, i) => ({ id: 100 + i, userId: r.userId, certificateCode: r.certificateCode })))),
    };
    const activity = { record: jest.fn().mockResolvedValue(undefined) };
    const notifications = { notify: jest.fn() };
    const service = new CertificatesService(repository as never, activity as never, notifications as never, { get: () => undefined } as never);
    return { service, repository, activity, notifications };
  }

  it('issues one certificate per eligible learner, with distinct codes, and notifies each once', async () => {
    const { service, repository, notifications, activity } = make({ courseId: 9, title: 'Fire safety', date: '2026-11-20', userIds: [1, 2, 3] });
    await expect(service.issueForSession(scope, 5)).resolves.toEqual({ issued: 3 });
    const rows = repository.insertMany.mock.calls[0][1];
    expect(rows.map((r: { userId: number }) => r.userId)).toEqual([1, 2, 3]);
    expect(new Set(rows.map((r: { certificateCode: string }) => r.certificateCode)).size).toBe(3);
    expect(notifications.notify).toHaveBeenCalledTimes(3);
    const first = notifications.notify.mock.calls[0][0];
    expect(first).toEqual(expect.objectContaining({
      userIds: [1], type: 'certificate_issued', title: 'Session completed: Fire safety',
      link: '/certifications', subjectType: 'certificate', subjectId: 100,
    }));
    expect(first.facts).toEqual(expect.arrayContaining([{ label: 'Date', value: '20 Nov 2026' }]));
    expect(activity.record).toHaveBeenCalledTimes(1);
    expect(activity.record.mock.calls[0][1].detail).toBe('Issued 3 session certificates for "Fire safety"');
  });

  it('does nothing when nobody is owed one (everyone already holds a certificate, or none attended)', async () => {
    const { service, repository, notifications, activity } = make({ courseId: 9, title: 'X', date: null, userIds: [] });
    await expect(service.issueForSession(scope, 5)).resolves.toEqual({ issued: 0 });
    expect(repository.insertMany).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('notifies only the rows the insert actually created (a concurrent completion took the rest)', async () => {
    const { service, notifications } = make(
      { courseId: 9, title: 'X', date: null, userIds: [1, 2] },
      (rows) => [{ id: 7, userId: rows[1].userId, certificateCode: rows[1].certificateCode }],
    );
    await expect(service.issueForSession(scope, 5)).resolves.toEqual({ issued: 1 });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify.mock.calls[0][0].userIds).toEqual([2]);
  });

  it('never throws into the completion that called it', async () => {
    const { service, repository } = make(null);
    repository.sessionCertificateCandidates.mockRejectedValue(new Error('db down'));
    await expect(service.issueForSession(scope, 5)).resolves.toEqual({ issued: 0 });
  });
});
