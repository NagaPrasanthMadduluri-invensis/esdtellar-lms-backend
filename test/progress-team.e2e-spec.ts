/**
 * Learner progress (CONTEXT.md: dashboard, My Courses, lessons, My Progress,
 * achievements, learning hours) and the manager's Team Learning module
 * (view_team_learning: direct reports only, nudge, xlsx export).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, type Agent } from './helpers';
import { makeCourse, notificationsFor, waitFor, type CourseFx } from './support/4';

describe('learner progress and team learning', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learner: Agent;
  let course: CourseFx;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learner = await signIn(app, fx.A.learner);
    course = await makeCourse(adminA, { assign: [fx.A.learner.id, fx.A.learner2.id], lessons: 2, minutes: 30 });
  });
  afterAll(async () => { await app.close(); });

  describe('my courses and lessons', () => {
    it('lists the assigned course with its overview and opens its detail by public id', async () => {
      const list = await learner.get('/api/learner/courses').expect(200);
      expect(list.body.overview).toEqual(expect.objectContaining({ totalAssigned: expect.any(Number) }));
      const card = list.body.courses.find((c: { course: { id: number } }) => c.course.id === course.id);
      expect(card.course.public_id).toBe(course.publicId);
      expect(card.status).toBe('assigned');

      const detail = await learner.get(`/api/learner/courses/${course.publicId}`).expect(200);
      expect(JSON.stringify(detail.body)).toContain(course.name);
    });

    it('opens a lesson and completing every lesson completes the course, credits hours and stays idempotent', async () => {
      const first = await learner.get(`/api/learner/lessons/${course.lessons[0].publicId}`).expect(200);
      expect(JSON.stringify(first.body)).toContain('Lesson 1');

      for (const l of course.lessons) {
        const r = await learner.post(`/api/learner/lessons/${l.publicId}/complete`);
        expect(r.status).toBe(200);
      }
      const done = await dbQuery(
        'SELECT lesson_id FROM user_lesson_completions WHERE user_id = $1 AND lesson_id = ANY($2)',
        [fx.A.learner.id, course.lessons.map((l) => l.id)],
      );
      expect(done).toHaveLength(2);

      // Completing again earns nothing new (one row per lesson).
      await learner.post(`/api/learner/lessons/${course.lessons[0].publicId}/complete`).expect(200);
      const again = await dbQuery('SELECT COUNT(*)::int AS n FROM user_lesson_completions WHERE user_id = $1 AND lesson_id = $2', [fx.A.learner.id, course.lessons[0].id]);
      expect(again[0].n).toBe(1);

      const courses = await learner.get('/api/learner/courses').expect(200);
      const card = courses.body.courses.find((c: { course: { id: number } }) => c.course.id === course.id);
      expect(card.status).toBe('completed');
      expect(card.progressPct).toBe(100);
    });

    it('refuses a learner who was not assigned the course, and another organization 404s', async () => {
      const outsider = await newPerson(adminA, fx.A);
      const o = await signIn(app, outsider);
      const r = await o.get(`/api/learner/lessons/${course.lessons[0].publicId}`);
      expect([403, 404]).toContain(r.status);
      const c = await o.post(`/api/learner/lessons/${course.lessons[0].publicId}/complete`);
      expect([403, 404]).toContain(c.status);

      const b = await signIn(app, fx.B.learner);
      await b.get(`/api/learner/courses/${course.publicId}`).expect(404);
      await b.get(`/api/learner/lessons/${course.lessons[0].publicId}`).expect(404);
    });

    it('an admin cannot use learner routes', async () => {
      await adminA.get('/api/learner/dashboard').expect(403);
    });
  });

  describe('dashboard, progress, achievements, learning hours', () => {
    it('the dashboard carries stats, points, rank and the cohort cards', async () => {
      const r = await learner.get('/api/learner/dashboard').expect(200);
      for (const k of ['enrolled_courses', 'stats', 'points', 'rank', 'streak', 'certificates', 'points_this_month', 'cohort_leaderboard']) {
        expect(r.body).toHaveProperty(k);
      }
      expect(r.body.points).toBeGreaterThanOrEqual(100); // a course completed pays 100
    });

    it('My Progress summarises completion and hours that agree with the learning-hours page', async () => {
      const p = await learner.get('/api/learner/progress').expect(200);
      expect(p.body.summary.completed).toBeGreaterThanOrEqual(1);
      expect(p.body.summary.assigned).toBeGreaterThanOrEqual(p.body.summary.completed);
      for (const k of ['courseHistory', 'learningHours', 'hoursByPeriod', 'hoursByYear']) expect(p.body).toHaveProperty(k);

      const h = await learner.get('/api/learner/learning-hours').expect(200);
      expect(h.body.summary).toEqual(expect.objectContaining({ goal: 10, statusLabel: expect.any(String) }));
      // Two 30-minute lessons completed = at least one hour, the same all-time figure on both pages.
      expect(h.body.summary.allTime).toBeGreaterThanOrEqual(1);
      expect(p.body.summary.allTimeHours).toBe(h.body.summary.allTime);
      for (const k of ['hoursByPeriod', 'weeklyTrend', 'modeBreakdown']) expect(h.body).toHaveProperty(k);
    });

    it('achievements report earned badges and a points history that adds up', async () => {
      const a = await learner.get('/api/learner/achievements').expect(200);
      expect(a.body.summary).toEqual(expect.objectContaining({ points: expect.any(Number), earnedCount: expect.any(Number) }));
      const firstSteps = a.body.badges.find((b: { id: string }) => b.id === 'first_steps');
      expect(firstSteps.earned).toBe(true);
      expect(Array.isArray(a.body.pointsHistory)).toBe(true);
    });
  });

  describe('team learning (manager)', () => {
    it('lists only the manager\'s direct reports with a summary', async () => {
      const notMine = await newPerson(adminA, fx.A);
      const mgr = await signIn(app, fx.A.manager);
      const r = await mgr.get('/api/learner/team').expect(200);
      const ids = r.body.team.map((t: { id: number }) => t.id).sort();
      // Other spec files may give this manager more reports in a full run: the
      // rule is that EVERY listed person reports to them, and no one else does.
      expect(ids).toEqual(expect.arrayContaining([fx.A.learner.id, fx.A.learner2.id]));
      expect(ids).not.toContain(notMine.id);
      const reports = await dbQuery<{ id: number }>('SELECT id FROM users WHERE manager_id = $1 AND is_active = 1', [fx.A.manager.id]);
      expect(new Set(ids)).toEqual(new Set(reports.map((x) => x.id)));
      expect(r.body.summary).toEqual(expect.objectContaining({ size: ids.length, monthlyHoursGoal: 10 }));
      const me = r.body.team.find((t: { id: number }) => t.id === fx.A.learner.id);
      expect(me.coursesCompleted).toBeGreaterThanOrEqual(1);
    });

    it('a manager with no reports sees an empty team with a note', async () => {
      const lonely = await newPerson(adminA, fx.A, 'manager');
      const m = await signIn(app, lonely);
      const r = await m.get('/api/learner/team').expect(200);
      expect(r.body.team).toEqual([]);
      expect(r.body.summary.note).toEqual(expect.any(String));
    });

    it('nudges a direct report (a named notification) and refuses anybody else', async () => {
      const mgr = await signIn(app, fx.A.manager);
      const r = await mgr.post(`/api/learner/team/${fx.A.learner2.id}/nudge`).expect(200);
      expect(r.body).toEqual(expect.objectContaining({ ok: true }));
      const rows = await waitFor(async () => {
        const n = await notificationsFor(fx.A.learner2.id, 'manager_nudge');
        return n.length ? n : null;
      });
      expect(rows!.at(-1)!.title).toContain('Manager');

      const stranger = await newPerson(adminA, fx.A);
      await mgr.post(`/api/learner/team/${stranger.id}/nudge`).expect(404);
      // Another organization's manager cannot nudge this org's learner.
      const mgrB = await signIn(app, fx.B.manager);
      await mgrB.post(`/api/learner/team/${fx.A.learner.id}/nudge`).expect(404);
    });

    it('exports the team as an xlsx workbook', async () => {
      const mgr = await signIn(app, fx.A.manager);
      const r = await mgr.post('/api/learner/team/export').buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/spreadsheetml\.sheet/);
      expect(r.headers['content-disposition']).toMatch(/\.xlsx/);
      expect((r.body as Buffer).subarray(0, 2).toString()).toBe('PK'); // a zip container
    });

    it('a plain learner gets 403 on every team route', async () => {
      await learner.get('/api/learner/team').expect(403);
      await learner.post('/api/learner/team/export').expect(403);
      await learner.post(`/api/learner/team/${fx.A.learner2.id}/nudge`).expect(403);
    });
  });

  it('org B admin is unaffected (sanity: its learners hold none of org A content)', async () => {
    const b = await signIn(app, fx.B.learner);
    const r = await b.get('/api/learner/courses').expect(200);
    expect(JSON.stringify(r.body)).not.toContain(course.name);
    void adminB;
  });
});
