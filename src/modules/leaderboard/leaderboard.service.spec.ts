import { leaderboardName, toNameDisplay } from '@/common/leaderboard-privacy';
import type { OrgScope } from '@/database/org-scope';

import type { LeaderboardRepository, LeaderboardRow } from './leaderboard.repository';
import { LeaderboardService, publicRank } from './leaderboard.service';

/**
 * Leaderboard privacy (0064). These pin the guarantees the privacy notice and
 * the DPIA rely on: an opted-out learner keeps their points but appears in no
 * ranking, the remaining ranks have no gap that points at them, and colleagues
 * are named by the organization's chosen display.
 */

const scope = { organizationId: 7 } as unknown as OrgScope;

function row(id: number, first: string, last: string, points: number, hidden = 0): LeaderboardRow {
  return {
    id,
    first_name: first,
    last_name: last,
    department: 'QA',
    avatar_url: null,
    leaderboard_hidden: hidden,
    passed: 1,
    attempts: 1,
    avg_score: 80,
    courses_month: 1,
    points,
    month_points: points,
    last_earned_at: `2026-11-0${id}T10:00:00Z`,
    completed_lessons: 1,
    assigned_lessons: 2,
  } as LeaderboardRow;
}

function service(rows: LeaderboardRow[], settings = { leaderboard_enabled: 1, leaderboard_name_display: 'initial' }) {
  const repo = {
    standings: jest.fn().mockResolvedValue(rows),
    settings: jest.fn().mockResolvedValue(settings),
  } as unknown as LeaderboardRepository;
  return new LeaderboardService(repo);
}

describe('leaderboardName', () => {
  it('shows first name and last initial by default', () => {
    expect(leaderboardName('Priya', 'Sharma', 'initial')).toBe('Priya S.');
  });
  it('shows the full name when the organization chose it', () => {
    expect(leaderboardName('Priya', 'Sharma', 'full')).toBe('Priya Sharma');
  });
  it('copes with a missing surname', () => {
    expect(leaderboardName('Priya', '', 'initial')).toBe('Priya');
  });
  it('treats an unknown stored value as the private display', () => {
    expect(toNameDisplay('nickname')).toBe('initial');
    expect(toNameDisplay(null)).toBe('initial');
  });
});

describe('LeaderboardService.standings privacy', () => {
  const rows = [
    row(1, 'Asha', 'Rao', 500),
    row(2, 'Ben', 'Mills', 400, 1), // opted out, would be #2
    row(3, 'Chen', 'Li', 300),
    row(4, 'Dev', 'Patel', 200),
  ];

  it('keeps an opted-out learner in entries with their points', async () => {
    const s = await service(rows).standings(scope);
    const ben = s.entries.find((e) => e.id === 2)!;
    expect(ben.points).toBe(400);
    expect(ben.hidden).toBe(true);
    expect(ben.rank).toBe(0);
  });

  it('ranks only participants, with no gap in the numbering', async () => {
    const s = await service(rows).standings(scope);
    expect(s.ranked.map((e) => e.id)).toEqual([1, 3, 4]);
    expect(s.ranked.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(s.byMonth.map((e) => e.id)).not.toContain(2);
    expect(s.hiddenCount).toBe(1);
  });

  it('never names an opted-out learner in recognition', async () => {
    const only = [row(2, 'Ben', 'Mills', 900, 1), row(3, 'Chen', 'Li', 10)];
    const s = await service(only).standings(scope);
    expect(s.recognition.learnerOfMonth?.id).toBe(3);
  });

  it('carries the public name per the organization display', async () => {
    const initial = await service(rows).standings(scope);
    expect(initial.ranked[0].publicName).toBe('Asha R.');
    expect(initial.ranked[0].name).toBe('Asha Rao');

    const full = await service(rows, { leaderboard_enabled: 1, leaderboard_name_display: 'full' }).standings(scope);
    expect(full.ranked[0].publicName).toBe('Asha Rao');
  });

  it('gives no public rank when hidden or when the board is off', async () => {
    const on = await service(rows).standings(scope);
    expect(publicRank(on, on.entries.find((e) => e.id === 3)!)).toBe(2);
    expect(publicRank(on, on.entries.find((e) => e.id === 2)!)).toBeNull();

    const off = await service(rows, { leaderboard_enabled: 0, leaderboard_name_display: 'initial' }).standings(scope);
    expect(off.settings.enabled).toBe(false);
    expect(publicRank(off, off.entries.find((e) => e.id === 3)!)).toBeNull();
  });
});
