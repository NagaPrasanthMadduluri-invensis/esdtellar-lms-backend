/**
 * Recognition: badges and the leaderboard's privacy controls (CONTEXT.md,
 * leaderboard privacy 0064): a learner who opts out keeps their points but
 * leaves the ranks; an organization that switches the board off gets 403.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, type Agent, type Person } from './helpers';
import { makeCourse } from './support/4';

describe('recognition', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let star: Person;
  let starAgent: Agent;
  let peer: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    star = await newPerson(adminA, fx.A);
    const peerP = await newPerson(adminA, fx.A);
    const course = await makeCourse(adminA, { assign: [star.id, peerP.id] });
    starAgent = await signIn(app, star);
    peer = await signIn(app, peerP);
    await starAgent.post(`/api/learner/lessons/${course.lessons[0].publicId}/complete`).expect(200);
  });
  afterAll(async () => {
    await dbQuery('UPDATE organizations SET leaderboard_enabled = 1 WHERE id = $1', [fx.A.id]).catch(() => undefined);
    await app.close();
  });

  it('lists the badge catalogue with what the learner has earned (stored awards)', async () => {
    const r = await starAgent.get('/api/learner/badges').expect(200);
    const first = r.body.badges.find((b: { id: string }) => b.id === 'first_steps');
    expect(first).toEqual(expect.objectContaining({ earned: true, earnedAt: expect.any(String) }));
    const stored = await dbQuery('SELECT badge_key FROM user_badges WHERE user_id = $1', [star.id]);
    expect(stored.map((s) => s.badge_key)).toContain('first_steps');
    expect(r.body).toHaveProperty('next');

    const fresh = await signIn(app, await newPerson(adminA, fx.A));
    const none = await fresh.get('/api/learner/badges').expect(200);
    expect(none.body.badges.every((b: { earned: boolean }) => !b.earned)).toBe(true);
    await adminA.get('/api/learner/badges').expect(403);
  });

  it('ranks a learner on the board with their points, by public name only', async () => {
    const r = await peer.get('/api/learner/leaderboard').expect(200);
    const row = r.body.allLearners.find((l: { id: number }) => l.id === star.id);
    expect(row).toBeDefined();
    expect(row.allTimePoints).toBeGreaterThanOrEqual(100);
    // Default name display is first name + last initial ("Temp" -> "T.").
    expect(row.name).toBe(`${star.firstName} T.`);
    expect(r.body.pointRules.length).toBeGreaterThan(0);
  });

  it('opting out keeps the points but drops the learner from every rank', async () => {
    await starAgent.patch('/api/auth/profile').send({ leaderboard_hidden: true }).expect((x) => expect(x.status).toBeLessThan(300));
    const [u] = await dbQuery('SELECT leaderboard_hidden FROM users WHERE id = $1', [star.id]);
    expect(Boolean(u.leaderboard_hidden)).toBe(true);

    const own = await starAgent.get('/api/learner/leaderboard').expect(200);
    expect(own.body.allLearners.map((l: { id: number }) => l.id)).not.toContain(star.id);
    expect(own.body.byMonth.map((l: { id: number }) => l.id)).not.toContain(star.id);
    expect(own.body.privacy.you).toEqual(expect.objectContaining({ hidden: true }));
    expect(own.body.privacy.you.allTimePoints).toBeGreaterThanOrEqual(100);

    const other = await peer.get('/api/learner/leaderboard').expect(200);
    expect(other.body.allLearners.map((l: { id: number }) => l.id)).not.toContain(star.id);
    expect(other.body.privacy.hiddenCount).toBeGreaterThanOrEqual(1);
    // Ranks are contiguous: no gap points at the hidden learner.
    const ranks = other.body.allLearners.map((l: { allTimeRank: number }) => l.allTimeRank);
    expect(ranks).toEqual(ranks.map((_: number, i: number) => i + 1));

    const ach = await starAgent.get('/api/learner/achievements').expect(200);
    expect(ach.body.summary.points).toBeGreaterThanOrEqual(100);
    expect(ach.body.summary.leaderboardHidden).toBe(true);
    expect(ach.body.summary.rank ?? null).toBeNull();

    await starAgent.patch('/api/auth/profile').send({ leaderboard_hidden: false }).expect((x) => expect(x.status).toBeLessThan(300));
    const back = await peer.get('/api/learner/leaderboard').expect(200);
    expect(back.body.allLearners.map((l: { id: number }) => l.id)).toContain(star.id);
  });

  it('the organization switch off makes the learner leaderboard 403 while points still accrue', async () => {
    await adminA.patch('/api/admin/organization').send({ leaderboard_enabled: false }).expect((x) => expect(x.status).toBeLessThan(300));
    try {
      const r = await peer.get('/api/learner/leaderboard');
      expect(r.status).toBe(403);
      expect(r.body.message).toMatch(/turned off/i);
      const dash = await starAgent.get('/api/learner/dashboard').expect(200);
      expect(dash.body.cohort_leaderboard).toBeNull();
      const ach = await starAgent.get('/api/learner/achievements').expect(200);
      expect(ach.body.summary.points).toBeGreaterThanOrEqual(100);
      expect(ach.body.summary.leaderboardEnabled).toBe(false);
    } finally {
      await adminA.patch('/api/admin/organization').send({ leaderboard_enabled: true }).expect((x) => expect(x.status).toBeLessThan(300));
    }
    await peer.get('/api/learner/leaderboard').expect(200);
  });

  it('the board never shows another organization\'s learners', async () => {
    const b = await signIn(app, fx.B.learner);
    const r = await b.get('/api/learner/leaderboard').expect(200);
    expect(r.body.allLearners.map((l: { id: number }) => l.id)).not.toContain(star.id);
  });
});
