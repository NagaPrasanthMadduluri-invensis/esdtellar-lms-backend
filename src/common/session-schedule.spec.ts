import {
  batchName, buildSittings, dailyMinutes, dateChange, datesBetween, formatSessionDates, MAX_SITTING_DAYS,
  normaliseDates, planSchedule, seatsAcrossDates,
} from './session-schedule';

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

describe('session dates (0076)', () => {
  it('writes dates as a person does, grouped by month, the year once', () => {
    expect(formatSessionDates(['2026-11-05', '2026-11-06', '2026-12-02'])).toBe('5th, 6th November and 2nd December 2026');
    expect(formatSessionDates(['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-11', '2026-11-12', '2026-11-13'])).toBe('11th, 12th, 13th, 21st, 22nd, 23rd November 2026');
    expect(formatSessionDates(['2026-12-31', '2027-01-02'])).toBe('31st December 2026 and 2nd January 2027');
    expect(formatSessionDates(['2026-03-01', '2026-04-02', '2026-05-03'])).toBe('1st March, 2nd April and 3rd May 2026');
    expect(formatSessionDates(['2026-11-05'])).toBe('5th November 2026');
    expect(formatSessionDates([])).toBe('');
  });

  it('a later date is postponed, an earlier one preponed', () => {
    expect(dateChange('2026-11-05', '2026-11-12')).toBe('postponed');
    expect(dateChange('2026-11-05', '2026-11-01')).toBe('preponed');
    expect(dateChange('2026-11-05', '2026-11-05')).toBeNull();
  });

  it('pairs a removed date with an added one, in order, as a move; the rest is added or removed', () => {
    expect(planSchedule(['2026-11-05', '2026-11-06'], ['2026-11-05', '2026-11-13'])).toEqual({
      moves: [{ from: '2026-11-06', to: '2026-11-13', change: 'postponed' }], added: [], removed: [],
    });
    expect(planSchedule(['2026-11-05', '2026-11-06'], ['2026-11-01', '2026-11-02', '2026-11-20'])).toEqual({
      moves: [
        { from: '2026-11-05', to: '2026-11-01', change: 'preponed' },
        { from: '2026-11-06', to: '2026-11-02', change: 'preponed' },
      ],
      added: ['2026-11-20'],
      removed: [],
    });
    expect(planSchedule(['2026-11-05', '2026-11-06'], ['2026-11-05'])).toEqual({ moves: [], added: [], removed: ['2026-11-06'] });
    expect(planSchedule(['2026-11-05'], ['2026-11-05'])).toEqual({ moves: [], added: [], removed: [] });
  });

  it('drops invalid and repeated dates and sorts', () => {
    expect(normaliseDates(['2026-11-06', 'x', '2026-11-05', '2026-11-06', '2026-02-31'])).toEqual(['2026-11-05', '2026-11-06']);
  });

  it('places for the whole training are the tightest date; length is the longest batch per date', () => {
    const sit = (date: string, dateId: number, capacity: number, available: number, minutes: number) =>
      ({ session_date_id: dateId, start_date: date, capacity, available, total_minutes: minutes, status: 'scheduled' }) as never;
    expect(seatsAcrossDates([sit('a', 1, 5, 2, 180), sit('a', 1, 5, 5, 120), sit('b', 2, 4, 1, 180)]))
      .toEqual({ capacity: 4, available: 1, minutes: 360 });
    expect(seatsAcrossDates([])).toEqual({ capacity: 0, available: 0, minutes: 0 });
  });
});
