/**
 * Engagement hours (CONTEXT.md §10.55, 0072): active seconds pinged by every
 * portal, at most 600 per ping, one accumulator per (user, day); the learner
 * sees their own engagement-vs-learning trend, the admin's org trend needs
 * view_reports. Engagement is drawn as the superset of learning per period.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, type Agent, type Person } from './helpers';
import { limitedAdmin, makeCourse } from './support/4';

const secondsToday = async (userId: number) =>
  (await dbQuery<{ s: number }>('SELECT COALESCE(SUM(active_seconds),0)::int AS s FROM engagement_daily WHERE user_id = $1 AND day = CURRENT_DATE', [userId]))[0].s;

describe('engagement', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let p: Person;
  let me: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    p = await newPerson(adminA, fx.A);
    me = await signIn(app, p);
  });
  afterAll(async () => { await app.close(); });

  it('accumulates pinged seconds into one row per day and refuses a ping over 600', async () => {
    const before = await secondsToday(p.id);
    const r = await me.post('/api/engagement/ping').send({ seconds: 600 }).expect(200);
    expect(r.body).toEqual({ ok: true });
    await me.post('/api/engagement/ping').send({ seconds: 120 }).expect(200);
    expect(await secondsToday(p.id)).toBe(before + 720);
    const rows = await dbQuery('SELECT organization_id FROM engagement_daily WHERE user_id = $1 AND day = CURRENT_DATE', [p.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_id).toBe(fx.A.id);

    await me.post('/api/engagement/ping').send({ seconds: 601 }).expect(400);
    await me.post('/api/engagement/ping').send({ seconds: 0 }).expect(400);
    expect(await secondsToday(p.id)).toBe(before + 720);
  });

  it('caps a day at 86400 seconds however many pings arrive', async () => {
    const q = await newPerson(adminA, fx.A);
    const qa = await signIn(app, q);
    await dbQuery("INSERT INTO engagement_daily (organization_id, user_id, day, active_seconds) VALUES ($1,$2,CURRENT_DATE,86300)", [fx.A.id, q.id]);
    await qa.post('/api/engagement/ping').send({ seconds: 600 }).expect(200);
    expect(await secondsToday(q.id)).toBe(86400);
  });

  it('every authenticated portal may ping; an anonymous caller may not', async () => {
    const trainer = await signIn(app, fx.A.trainer);
    await trainer.post('/api/engagement/ping').send({ seconds: 30 }).expect(200);
    await adminA.post('/api/engagement/ping').send({ seconds: 30 }).expect(200);
    const anonymous = (await import('./helpers')).anon(app);
    await anonymous.post('/api/engagement/ping').send({ seconds: 30 }).expect(401);
  });

  it('the learner trend reads their own figures, with engagement never below learning per period', async () => {
    const course = await makeCourse(adminA, { assign: [p.id], minutes: 60 });
    await me.post(`/api/learner/lessons/${course.lessons[0].publicId}/complete`).expect(200);

    for (const g of ['weekly', 'monthly', 'quarterly', 'yearly']) {
      const r = await me.get('/api/learner/engagement/trend').query({ granularity: g }).expect(200);
      expect(r.body.granularity).toBe(g);
      expect(r.body.series.length).toBeGreaterThan(0);
      for (const s of r.body.series) expect(s.engagementHours).toBeGreaterThanOrEqual(s.learningHours);
      expect(r.body.totals.learningHours).toBeGreaterThanOrEqual(1);
    }
    // The learning series is the learning-hours definition (agrees with the page).
    const hours = await me.get('/api/learner/learning-hours').expect(200);
    const yearly = await me.get('/api/learner/engagement/trend').query({ granularity: 'yearly' }).expect(200);
    expect(yearly.body.totals.learningHours).toBe(hours.body.summary.allTime);

    await me.get('/api/learner/engagement/trend').query({ granularity: 'daily' }).expect(400);
    await adminA.get('/api/learner/engagement/trend').expect(403);
  });

  it('the admin org trend needs view_reports and is org-scoped', async () => {
    const r = await adminA.get('/api/admin/engagement/trend').query({ granularity: 'monthly' }).expect(200);
    expect(r.body).toEqual(expect.objectContaining({ granularity: 'monthly', series: expect.any(Array), totals: expect.any(Object) }));
    expect(r.body.totals.engagementHours).toBeGreaterThan(0);

    const adminB = await signIn(app, fx.B.admin);
    const rb = await adminB.get('/api/admin/engagement/trend').query({ granularity: 'monthly' }).expect(200);
    expect(rb.body.totals.engagementHours).toBeLessThan(r.body.totals.engagementHours);

    const { agent: noReports } = await limitedAdmin(app, adminA, fx.A, ['manage_courses']);
    await noReports.get('/api/admin/engagement/trend').expect(403);
    await me.get('/api/admin/engagement/trend').expect(403);
  });
});
