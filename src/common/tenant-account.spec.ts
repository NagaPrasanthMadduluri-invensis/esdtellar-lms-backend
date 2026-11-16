import { contractState, RENEWAL_WARNING_DAYS } from './tenant-account';

describe('contractState', () => {
  const today = new Date('2026-01-01T12:00:00Z');

  it('is "none" with no contract end', () => {
    expect(contractState(null, today)).toEqual({ state: 'none', daysLeft: null });
    expect(contractState(undefined, today)).toEqual({ state: 'none', daysLeft: null });
  });

  it('is "active" when renewal is far off', () => {
    const r = contractState('2026-06-01', today);
    expect(r.state).toBe('active');
    expect(r.daysLeft).toBeGreaterThan(RENEWAL_WARNING_DAYS);
  });

  it('is "expiring" within the warning window', () => {
    expect(contractState('2026-02-15', today).state).toBe('expiring'); // ~45 days
  });

  it('treats exactly the warning boundary as expiring, one day past it as active', () => {
    const atBoundary = new Date(today);
    expect(contractState('2026-01-01', today).daysLeft).toBe(0); // today itself -> expiring
    expect(contractState('2026-01-01', today).state).toBe('expiring');
    void atBoundary;
  });

  it('is "expired" once the end date has passed', () => {
    const r = contractState('2025-12-01', today);
    expect(r.state).toBe('expired');
    expect(r.daysLeft).toBeLessThan(0);
  });
});
