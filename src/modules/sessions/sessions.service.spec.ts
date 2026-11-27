import { NotFoundException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as never;

function make(deletable: Set<number>) {
  const repository = {
    findTrainingThumbnail: jest.fn().mockResolvedValue(null),
    deleteSession: jest.fn((_s: unknown, id: number) => Promise.resolve(deletable.has(id))),
  };
  const media = { discardCourseThumbnail: jest.fn().mockResolvedValue(undefined) };
  const service = new SessionsService(repository as never, media as never, { record: jest.fn() } as never, { notify: jest.fn() } as never, { issueForSession: jest.fn().mockResolvedValue({ issued: 0 }) } as never);
  return { service, repository };
}

describe('SessionsService delete', () => {
  it('404s a session that is not this org\'s (nothing was deleted)', async () => {
    const { service } = make(new Set());
    await expect(service.remove(scope, 42)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes its own session', async () => {
    const { service } = make(new Set([42]));
    await expect(service.remove(scope, 42)).resolves.toEqual({ message: 'Session deleted' });
  });

  it('bulk delete counts only sessions actually deleted', async () => {
    const { service } = make(new Set([1]));
    await expect(service.bulk(scope, [1, 2, 99999999], 'delete')).resolves.toEqual({ affected: 1, requested: 3, action: 'delete' });
  });
});

describe('SessionsService complete issues session certificates (§10.66)', () => {
  function makeComplete(issued: number) {
    const repository = {
      findStatus: jest.fn().mockResolvedValue({ status: 'upcoming' }),
      attendanceTally: jest.fn().mockResolvedValue({ credited: 3, marked: 4, total: 4, unmarked: 0 }),
      updateSession: jest.fn().mockResolvedValue(undefined),
      syncCompletions: jest.fn().mockResolvedValue(undefined),
      findWithCourse: jest.fn().mockResolvedValue({ id: 5, status: 'completed', date: null }),
    };
    const certificates = { issueForSession: jest.fn().mockResolvedValue({ issued }) };
    const service = new SessionsService(
      repository as never,
      {} as never,
      { record: jest.fn() } as never,
      { notify: jest.fn() } as never,
      certificates as never,
    );
    (service as unknown as { assertAttendanceMarked: () => void }).assertAttendanceMarked = () => undefined;
    return { service, repository, certificates };
  }

  it('credits first, then issues, and says how many certificates went out', async () => {
    const { service, repository, certificates } = makeComplete(3);
    const actor = { userId: 1 } as never;
    const res = await service.complete(scope, 5, actor);
    expect(repository.syncCompletions).toHaveBeenCalledWith(scope, 5);
    expect(certificates.issueForSession).toHaveBeenCalledWith(scope, 5, actor);
    expect(repository.syncCompletions.mock.invocationCallOrder[0])
      .toBeLessThan(certificates.issueForSession.mock.invocationCallOrder[0]);
    expect(res.certificatesIssued).toBe(3);
    expect(res.message).toBe('3 learners credited with this training; 3 certificates issued and emailed.');
  });

  it('a re-completion that issues nothing says only what was credited', async () => {
    const { service } = makeComplete(0);
    const res = await service.complete(scope, 5);
    expect(res.message).toBe('3 learners credited with this training.');
  });
});

describe('SessionsService schedule (0076)', () => {
  const dates = [
    { id: 11, session_id: 5, date: '2030-06-02', original_date: '2030-06-02', previous_date: null, change: null, changed_at: null },
    { id: 12, session_id: 5, date: '2030-06-03', original_date: '2030-06-03', previous_date: null, change: null, changed_at: null },
  ];
  function makeSchedule(opts: { status?: string; marked?: number } = {}) {
    const repository = {
      listDatesForSessions: jest.fn().mockResolvedValue(dates),
      findStatus: jest.fn().mockResolvedValue({ id: 5, status: opts.status ?? 'upcoming' }),
      findDate: jest.fn((_s: unknown, id: number) => Promise.resolve(dates.find((d) => d.id === id) ?? null)),
      markedOnDate: jest.fn().mockResolvedValue(opts.marked ?? 0),
      moveDate: jest.fn().mockResolvedValue(undefined),
      deleteDate: jest.fn().mockResolvedValue(undefined),
      insertDates: jest.fn().mockResolvedValue([{ id: 13, date: '2030-06-20' }]),
      slotsOfDate: jest.fn().mockResolvedValue([{ label: 'AM', start_time: '09:00', end_time: '12:00', capacity: 5, trainer_user_id: null }]),
      createBatchesForDates: jest.fn().mockResolvedValue(undefined),
      syncSessionSummary: jest.fn().mockResolvedValue(undefined),
      autoPlace: jest.fn().mockResolvedValue(undefined),
      rollUpAttendance: jest.fn().mockResolvedValue(undefined),
      findWithCourse: jest.fn().mockResolvedValue({ id: 5, title: 'Negotiation', start_time: '09:00', end_time: '12:00', capacity: 10, status: 'upcoming' }),
      setTrainingDuration: jest.fn().mockResolvedValue(undefined),
      listBatchesForSessions: jest.fn().mockResolvedValue([]),
      rosterCount: jest.fn().mockResolvedValue(0),
      scheduleAudience: jest.fn().mockResolvedValue({ learners: [21, 22], trainers: [30] }),
    };
    const notifications = { notify: jest.fn() };
    const activity = { record: jest.fn() };
    const service = new SessionsService(repository as never, {} as never, activity as never, notifications as never, {} as never);
    return { service, repository, notifications, activity };
  }

  it('moving a date later keeps its row, labels it postponed and tells learners and the trainer once each', async () => {
    const { service, repository, notifications, activity } = makeSchedule();
    const out = await service.moveDate(scope, 12, '2030-06-10');
    expect(repository.moveDate).toHaveBeenCalledWith(scope, 12, '2030-06-10', 'postponed');
    expect(repository.deleteDate).not.toHaveBeenCalled();
    expect(out.changes.moves).toEqual([{ from: '2030-06-03', to: '2030-06-10', change: 'postponed' }]);
    expect(notifications.notify).toHaveBeenCalledTimes(2);
    const [learners] = notifications.notify.mock.calls.map((c) => c[0]).filter((n) => n.userIds.includes(21));
    expect(learners).toMatchObject({ type: 'session_rescheduled', title: 'Postponed: Negotiation', userIds: [21, 22] });
    expect(learners.facts).toEqual(expect.arrayContaining([{ label: 'Postponed', value: '3 Jun 2030 moved to 10 Jun 2030' }]));
    expect(activity.record).toHaveBeenCalledWith(scope, expect.objectContaining({ type: 'session_rescheduled' }));
    // The training's length follows the dates.
    expect(repository.setTrainingDuration).not.toHaveBeenCalled();
  });

  it('a new date copies the batches of the nearest date and lengthens the training', async () => {
    const { service, repository } = makeSchedule();
    await service.setSchedule(scope, 5, ['2030-06-02', '2030-06-03', '2030-06-20']);
    expect(repository.slotsOfDate).toHaveBeenCalledWith(scope, 12);
    expect(repository.createBatchesForDates).toHaveBeenCalledWith(scope, 5, [{ id: 13, date: '2030-06-20' }], [expect.objectContaining({ label: 'AM', capacity: 5 })]);
    expect(repository.autoPlace).toHaveBeenCalled();
    expect(repository.setTrainingDuration).toHaveBeenCalledWith(scope, 5, 360);
  });

  it('refuses to remove a date with attendance marked, and to change a completed session', async () => {
    await expect(makeSchedule({ marked: 2 }).service.setSchedule(scope, 5, ['2030-06-02'])).rejects.toThrow(/2 learners on 3 Jun 2030/);
    await expect(makeSchedule({ status: 'completed' }).service.moveDate(scope, 12, '2030-06-10')).rejects.toThrow(/completed/);
  });

  it('an unchanged set changes nothing and tells nobody', async () => {
    const { service, repository, notifications } = makeSchedule();
    const out = await service.setSchedule(scope, 5, ['2030-06-03', '2030-06-02']);
    expect(out.changes).toEqual({ moves: [], added: [], removed: [] });
    expect(repository.moveDate).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
