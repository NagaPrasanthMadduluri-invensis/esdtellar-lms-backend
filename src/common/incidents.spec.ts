import { incidentDeadlines, nextDeadline, toTime } from './incidents';

const base = {
  discovered_at: '2026-11-10T09:00:00.000Z',
  assessment: 'undecided',
  assessed_at: null,
  clients_notified_at: null,
  regulator_notified_at: null,
  individuals_notified_at: null,
  affected_organizations: 2,
};
const at = (s: string) => Date.parse(s);

describe('incidentDeadlines', () => {
  it('runs the assessment, client and 72-hour clocks from discovery while undecided', () => {
    const d = incidentDeadlines(base, at('2026-11-10T12:00:00Z'));
    expect(d.map((x) => x.key)).toEqual(['clients', 'regulator_72h', 'assessment']);
    expect(d.find((x) => x.key === 'clients')!.due_at).toBe('2026-11-11T09:00:00.000Z');
    expect(d.find((x) => x.key === 'regulator_72h')!.due_at).toBe('2026-11-13T09:00:00.000Z');
    expect(d.find((x) => x.key === 'assessment')!.due_at).toBe('2026-12-10T09:00:00.000Z');
  });

  it('marks the client clock due soon, then overdue, then done', () => {
    const clients = (now: string, notified: string | null = null) =>
      incidentDeadlines({ ...base, clients_notified_at: notified }, at(now)).find((x) => x.key === 'clients')!.state;
    expect(clients('2026-11-10T09:30:00Z')).toBe('due_soon');
    expect(clients('2026-11-11T10:00:00Z')).toBe('overdue');
    expect(clients('2026-11-11T10:00:00Z', '2026-11-10 20:00:00+00')).toBe('done');
  });

  it('adds the PDPC 3-day clock from the assessment, and individuals, once notifiable', () => {
    const d = incidentDeadlines(
      { ...base, assessment: 'notifiable', assessed_at: '2026-11-12T09:00:00.000Z' },
      at('2026-11-12T10:00:00Z'),
    );
    expect(d.find((x) => x.key === 'regulator_pdpa')!.due_at).toBe('2026-11-15T09:00:00.000Z');
    expect(d.find((x) => x.key === 'individuals')!.due_at).toBeNull();
    expect(d.find((x) => x.key === 'assessment')!.state).toBe('done');
  });

  it('drops the regulator clocks once assessed not notifiable, and the client clock with no organization', () => {
    const d = incidentDeadlines(
      { ...base, assessment: 'not_notifiable', assessed_at: '2026-11-11T09:00:00Z', affected_organizations: 0 },
      at('2026-11-20T00:00:00Z'),
    );
    expect(d.map((x) => x.key)).toEqual(['assessment']);
  });

  it('nextDeadline prefers an overdue clock', () => {
    const d = incidentDeadlines(base, at('2026-11-11T10:00:00Z'));
    expect(nextDeadline(d)!.key).toBe('clients');
  });

  it('toTime repairs a Postgres +00 offset', () => {
    expect(toTime('2026-11-10 09:00:00+00')).toBe(at('2026-11-10T09:00:00Z'));
  });
});
