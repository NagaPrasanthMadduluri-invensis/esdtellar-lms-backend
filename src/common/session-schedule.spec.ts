import { batchName, buildSittings, dailyMinutes, datesBetween, MAX_SITTING_DAYS } from './session-schedule';

const SESSION = {
  title: 'Negotiation Lab', date: '2026-12-01', end_date: null, start_time: '09:00', end_time: '12:30',
  capacity: 20, status: 'upcoming', roster_count: 7, waitlist_count: 0, trainer: 'R. Iyer',
};

describe('datesBetween', () => {
  it('spans inclusive days, including across a month end', () => {
    expect(datesBetween('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  });
  it('a missing or earlier end is one day; a bad start is none', () => {
    expect(datesBetween('2026-12-01', null)).toEqual(['2026-12-01']);
    expect(datesBetween('2026-12-05', '2026-12-01')).toEqual(['2026-12-05']);
    expect(datesBetween(null, '2026-12-01')).toEqual([]);
    expect(datesBetween('01/12/2026')).toEqual([]);
  });
  it('is capped', () => {
    expect(datesBetween('2026-01-01', '2027-01-01')).toHaveLength(MAX_SITTING_DAYS);
  });
});

describe('dailyMinutes', () => {
  it('reads HH:MM and refuses an end before the start', () => {
    expect(dailyMinutes('09:00', '12:30')).toBe(210);
    expect(dailyMinutes('14:00', '09:00')).toBeNull();
    expect(dailyMinutes(null, '09:00')).toBeNull();
  });
});

describe('buildSittings', () => {
  it('a session with no batches is one sitting of its own', () => {
    const [s] = buildSittings({ ...SESSION, end_date: '2026-12-03' }, []);
    expect(s).toMatchObject({
      batch_id: null, name: 'Negotiation Lab', start_date: '2026-12-01', end_date: '2026-12-03',
      capacity: 20, registered: 7, available: 13, is_full: false, total_minutes: 630, status: 'scheduled',
    });
    expect(s.dates).toHaveLength(3);
  });

  it('batches keep independent capacity, fall back to session times and capacity, and order by number', () => {
    const out = buildSittings(SESSION, [
      { id: 12, batch_no: 2, label: 'Afternoon', date: '2026-12-01', start_time: '14:00', end_time: '17:00', capacity: 3, status: 'scheduled', roster_count: 3, waitlist_count: 2 },
      { id: 11, batch_no: 1, label: null, date: '2026-12-01', end_date: '2026-12-02', start_time: null, end_time: null, capacity: null, status: 'scheduled', roster_count: 4 },
      { id: 13, batch_no: 3, label: null, date: null, start_time: null, end_time: null, capacity: 10, status: 'scheduled', roster_count: 0 },
    ]);
    expect(out.map((s) => s.name)).toEqual(['Batch 1', 'Batch 2 · Afternoon', 'Batch 3']);
    expect(out[0]).toMatchObject({ start_time: '09:00', end_time: '12:30', capacity: 20, available: 16, dates: ['2026-12-01', '2026-12-02'], total_minutes: 420 });
    expect(out[1]).toMatchObject({ capacity: 3, registered: 3, available: 0, is_full: true, waitlist: 2, total_minutes: 180 });
    expect(out[2]).toMatchObject({ status: 'pending', dates: [], total_minutes: null });
  });

  it('a cancelled session sitting reads cancelled', () => {
    expect(buildSittings({ ...SESSION, status: 'cancelled' }, [])[0].status).toBe('cancelled');
  });

  it('names a batch with or without a label', () => {
    expect(batchName(4, '  Evening ')).toBe('Batch 4 · Evening');
    expect(batchName(4, '')).toBe('Batch 4');
  });
});
