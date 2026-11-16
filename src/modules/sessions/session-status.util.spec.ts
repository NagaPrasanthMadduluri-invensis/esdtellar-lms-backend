import { displayStatus } from './session-status.util';

describe('displayStatus', () => {
  const now = new Date('2026-06-15T12:00:00');

  it('a human decision outranks the clock', () => {
    expect(displayStatus({ status: 'completed', date: '2030-01-01', start_time: '09:00' }, now)).toBe('completed');
    expect(displayStatus({ status: 'cancelled', date: '2020-01-01', start_time: '09:00' }, now)).toBe('cancelled');
  });

  it('is "in_progress" once the start time has passed', () => {
    expect(displayStatus({ status: 'upcoming', date: '2026-06-15', start_time: '09:00' }, now)).toBe('in_progress');
    // past its day entirely, still not completed -> stays in_progress deliberately
    expect(displayStatus({ status: 'upcoming', date: '2026-06-01', start_time: '09:00' }, now)).toBe('in_progress');
  });

  it('is "upcoming" before the start time', () => {
    expect(displayStatus({ status: 'upcoming', date: '2026-06-15', start_time: '18:00' }, now)).toBe('upcoming');
    expect(displayStatus({ status: 'upcoming', date: '2026-07-01', start_time: '09:00' }, now)).toBe('upcoming');
  });

  it('falls back to "upcoming" when the schedule is missing or unparseable', () => {
    expect(displayStatus({ status: 'upcoming' }, now)).toBe('upcoming');
    expect(displayStatus({ status: 'upcoming', date: 'not-a-date', start_time: 'xx' }, now)).toBe('upcoming');
  });

  it('defaults a missing stored status to upcoming', () => {
    expect(displayStatus({ date: '2026-07-01', start_time: '09:00' }, now)).toBe('upcoming');
  });
});
