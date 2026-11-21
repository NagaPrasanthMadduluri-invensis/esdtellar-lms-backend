/**
 * Insight (CONTEXT.md §12) and the activity log (§11): the admin dashboard,
 * Action Required + nudge, Recent Activity, the analytics page at every
 * granularity, the reports builder (group / individual / comparison) and its
 * .xlsx exports, the legacy report reads, and the audit-backed activity log
 * for a tenant and for the platform.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'supertest';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, type Agent } from './helpers';
import { limitedAdmin, makeCourse, waitFor } from './support/6';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Collect a binary body into a Buffer (supertest does not parse xlsx). */
function binary(res: Response, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

function expectXlsx(r: Response & { body: Buffer }) {
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toContain(XLSX);
  expect(r.headers['content-disposition']).toMatch(/^attachment; filename=".+\.xlsx"$/);
  expect(String(r.headers['access-control-expose-headers'])).toMatch(/Content-Disposition/i);
  // An .xlsx is a zip: it starts with the PK signature.
  expect(r.body.subarray(0, 2).toString()).toBe('PK');
  expect(r.body.length).toBeGreaterThan(1000);
}

describe('reports and analytics', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let course: Awaited<ReturnType<typeof makeCourse>>;
  let learnerId: number;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    const p = await newPerson(adminA, fx.A);
    learnerId = p.id;
    course = await makeCourse(adminA, [learnerId]);
  });
  afterAll(async () => { await app.close(); });

  describe('dashboard', () => {
    it('returns the KPI blocks counted from this organization only', async () => {
      const r = await adminA.get('/api/admin/dashboard').expect(200);
      expect(r.body).toEqual(expect.objectContaining({
        stats: expect.any(Object), headline: expect.any(Object), engagement: expect.any(Object),
        statusBreakdown: expect.any(Array), deptCompletion: expect.any(Array),
      }));
      const [{ n }] = await dbQuery<{ n: number }>(
        // The dashboard's definition (analytics.repository dashboardCounts): every
        // PUBLISHED course the org owns, incl. session companion courses and archived
        // ones (owner question raised 2026-11-20 whether those two should count).
        "SELECT COUNT(*)::int AS n FROM courses WHERE organization_id = $1 AND is_active = 1", [fx.A.id]);
      expect(r.body.stats.totalCourses).toBe(n);
      // Org B never sees org A's course.
      const b = await adminB.get('/api/admin/dashboard').expect(200);
      const [{ nb }] = await dbQuery<{ nb: number }>(
        "SELECT COUNT(*)::int AS nb FROM courses WHERE organization_id = $1 AND session_id IS NULL AND archived_at IS NULL", [fx.B.id]);
      expect(b.body.stats.totalCourses).toBe(nb);
    });

    it('lists the not-started assignment in Action Required, and a nudge notifies only that learner', async () => {
      const r = await adminA.get('/api/admin/dashboard/action-required').expect(200);
      const item = r.body.items.find((i: { user_id: number; course_id: number }) => i.user_id === learnerId && i.course_id === course.id);
      expect(item).toEqual(expect.objectContaining({ kind: 'not-started', progress: 0, action: 'Send nudge', course_name: course.name }));

      const n = await adminA.post('/api/admin/dashboard/nudge').send({ user_id: learnerId, course_id: course.id }).expect(200);
      expect(n.body).toEqual({ ok: true });
      const rows = await waitFor(async () => {
        const x = await dbQuery("SELECT user_id, organization_id, subject_id FROM notifications WHERE type = 'course_nudge' AND user_id = $1", [learnerId]);
        return x.length ? x : null;
      });
      expect(rows).toEqual([expect.objectContaining({ organization_id: fx.A.id, subject_id: course.id })]);
    });

    it('refuses a nudge for a learner/course that is not an assignment in the caller org (404)', async () => {
      await adminB.post('/api/admin/dashboard/nudge').send({ user_id: learnerId, course_id: course.id }).expect(404);
      await adminA.post('/api/admin/dashboard/nudge').send({ user_id: fx.A.learner2.id, course_id: course.id }).expect(404);
      await adminA.post('/api/admin/dashboard/nudge').send({ user_id: 'x', course_id: course.id }).expect(400);
    });

    it('shows Recent Activity for the org, newest first, and never the other org', async () => {
      const r = await adminA.get('/api/admin/dashboard/activity').query({ limit: 50 }).expect(200);
      expect(r.body.total).toBeGreaterThan(0);
      const types = r.body.activity.map((a: { type: string; subject_id: number }) => `${a.type}:${a.subject_id}`);
      expect(types).toEqual(expect.arrayContaining([`course_published:${course.id}`, `learning_assigned:${course.id}`]));
      const b = await adminB.get('/api/admin/dashboard/activity').query({ limit: 50 }).expect(200);
      expect(b.body.activity.some((a: { subject_type: string; subject_id: number }) => a.subject_type === 'course' && a.subject_id === course.id)).toBe(false);
      const limited = await adminA.get('/api/admin/dashboard/activity').query({ limit: 1 }).expect(200);
      expect(limited.body.activity).toHaveLength(1);
    });
  });

  describe('analytics', () => {
    it('answers every granularity, weekly keyed by Monday week-starts', async () => {
      for (const g of ['weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly', 'multi-year']) {
        const r = await adminA.get('/api/admin/analytics').query({ granularity: g }).expect(200);
        expect(r.body.granularity).toBe(g);
        expect(r.body.periods.length).toBeGreaterThan(0);
        for (const s of ['hours', 'enrollments', 'completions', 'learnersJoined', 'learnersActive', 'certificates']) {
          expect(r.body.series[s]).toHaveLength(r.body.periods.length);
        }
        expect(typeof r.body.sufficient).toBe('boolean');
      }
      const w = await adminA.get('/api/admin/analytics').query({ granularity: 'weekly' }).expect(200);
      for (const p of w.body.periods) {
        expect(p.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(new Date(`${p.key}T00:00:00Z`).getUTCDay()).toBe(1);
      }
      // Default is monthly; an unknown granularity is refused.
      expect((await adminA.get('/api/admin/analytics').expect(200)).body.granularity).toBe('monthly');
      await adminA.get('/api/admin/analytics').query({ granularity: 'daily' }).expect(400);
    });

    it('says the trend is insufficient with fewer than three periods of hours, and sufficient once there are three', async () => {
      // Org B: no learning at all yet -> not a trend.
      const before = await adminB.get('/api/admin/analytics').query({ granularity: 'monthly' }).expect(200);
      expect(before.body.sufficient).toBe(false);

      // A learner in org B with completions in three different months.
      const p = await newPerson(adminB, fx.B);
      const c = await makeCourse(adminB, [p.id]);
      const extra: number[] = [];
      for (const t of ['L2', 'L3']) {
        const l = await adminB.post(`/api/admin/modules/${c.moduleId}/lessons`)
          .send({ title: t, content_type: 'link', content_url: 'https://example.test/x', duration_minutes: 60 }).expect(201);
        extra.push(l.body.lesson.id);
      }
      const lessons = [c.lessonId, ...extra];
      await dbQuery("UPDATE user_course_assignments SET assigned_at = now() - interval '120 days' WHERE user_id = $1 AND course_id = $2", [p.id, c.id]);
      for (const [i, lessonId] of lessons.entries()) {
        await dbQuery(
          `INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at, organization_id) VALUES ($1, $2, now() - ($3 || ' days')::interval, $4)`,
          [p.id, lessonId, String(i * 40), fx.B.id],
        );
      }
      const after = await adminB.get('/api/admin/analytics').query({ granularity: 'monthly' }).expect(200);
      expect(after.body.series.hours.filter((h: number) => h > 0).length).toBeGreaterThanOrEqual(3);
      expect(after.body.sufficient).toBe(true);
      expect(after.body.engagement.totalHours).toBeGreaterThanOrEqual(2.5);
      // Org A's analytics did not pick any of it up.
      const a = await adminA.get('/api/admin/analytics').query({ granularity: 'monthly' }).expect(200);
      expect(a.body.learnerEngagement.some((l: { id: number }) => l.id === p.id)).toBe(false);
    });
  });

  describe('reports builder', () => {
    it('offers the five report types, the windows, dimensions, metrics and the org learners', async () => {
      const r = await adminA.get('/api/admin/reports/options').expect(200);
      expect(r.body.types.map((t: { key: string }) => t.key)).toEqual(['completion', 'hours', 'assessment', 'attendance', 'trainer']);
      expect(r.body.windows.map((w: { key: string }) => w.key)).toEqual(['month', 'quarter', 'year', 'all']);
      expect(r.body.dimensions.map((d: { key: string }) => d.key)).toEqual(expect.arrayContaining(['department', 'individual']));
      expect(r.body.learners.some((l: { id: number }) => l.id === learnerId)).toBe(true);
      expect(r.body.learners.some((l: { id: number }) => l.id === fx.B.learner.id)).toBe(false);
    });

    it('builds a group report with one section per type', async () => {
      const types = ['completion', 'hours', 'assessment', 'attendance', 'trainer'];
      const r = await adminA.post('/api/admin/reports/group').send({ types, window: 'all' }).expect(200);
      expect(r.body.window).toBe('All time');
      expect(r.body.reports.map((s: { key: string }) => s.key)).toEqual(types);
      for (const s of r.body.reports) {
        expect(s).toEqual(expect.objectContaining({ title: expect.any(String), kpis: expect.any(Array), columns: expect.any(Array), rows: expect.any(Array), totalRows: expect.any(Number) }));
      }
      const completion = r.body.reports[0];
      expect(completion.rows.some((row: string[]) => row.includes(course.name))).toBe(true);
      // A filter that matches nobody is an empty report, not an error.
      const empty = await adminA.post('/api/admin/reports/group').send({ types: ['completion'], department: 'No Such Dept' }).expect(200);
      expect(empty.body.reports[0].rows).toHaveLength(0);
      // Nothing ticked, or an unknown type, is refused.
      await adminA.post('/api/admin/reports/group').send({ types: [] }).expect(400);
      await adminA.post('/api/admin/reports/group').send({ types: ['certificates'] }).expect(400);
    });

    it('builds an individual report for one of the org learners, and nothing for another org person', async () => {
      const r = await adminA.post('/api/admin/reports/individual').send({ user_id: learnerId }).expect(200);
      expect(r.body.person).toEqual(expect.objectContaining({ id: learnerId }));
      expect(r.body.report.rows).toEqual([expect.arrayContaining([course.name, '0%', 'Not started'])]);
      const cross = await adminB.post('/api/admin/reports/individual').send({ user_id: learnerId }).expect(200);
      expect(cross.body.person).toBeNull();
      expect(cross.body.report).toBeNull();
    });

    it('builds a comparison of N items by M metrics', async () => {
      const r = await adminA.post('/api/admin/reports/comparison')
        .send({ dimension: 'department', items: ['Engineering'], metrics: ['completion', 'hours', 'enrolments'] }).expect(200);
      expect(r.body.reports.map((s: { key: string }) => s.key)).toEqual(['cmp-completion', 'cmp-hours', 'cmp-enrolments']);
      expect(r.body.reports[0].rows[0][0]).toBe('Engineering');
      await adminA.post('/api/admin/reports/comparison').send({ dimension: 'department', items: Array.from({ length: 13 }, (_, i) => `D${i}`), metrics: ['hours'] }).expect(400);
      await adminA.post('/api/admin/reports/comparison').send({ dimension: 'planet', items: ['x'], metrics: ['hours'] }).expect(400);
    });

    it('downloads all three reports as .xlsx with the filename readable cross-origin', async () => {
      expectXlsx(await adminA.post('/api/admin/reports/group/export').send({ types: ['completion', 'hours'] }).buffer(true).parse(binary) as never);
      const ind = await adminA.post('/api/admin/reports/individual/export').send({ user_id: learnerId }).buffer(true).parse(binary);
      expectXlsx(ind as never);
      expect(ind.headers['content-disposition']).toMatch(/Individual/);
      expectXlsx(await adminA.post('/api/admin/reports/comparison/export').send({ dimension: 'department', items: ['Engineering'], metrics: ['hours'] }).buffer(true).parse(binary) as never);
      expectXlsx(await adminA.get('/api/admin/export').buffer(true).parse(binary) as never);
    });
  });

  describe('the older report reads', () => {
    it('reports, departments, leaderboard and learning-hours answer for the org only', async () => {
      const rep = await adminA.get('/api/admin/reports').expect(200);
      expect(rep.body).toEqual(expect.objectContaining({ stats: expect.any(Object), statusBreakdown: expect.any(Array), deptCompletion: expect.any(Array) }));
      const dep = await adminA.get('/api/admin/departments').expect(200);
      expect(dep.body.departments.find((d: { dept: string }) => d.dept === 'Engineering')).toBeTruthy();
      const lb = await adminA.get('/api/admin/leaderboard').expect(200);
      const ids = lb.body.learners.map((l: { id: number }) => l.id);
      expect(ids).toEqual(expect.arrayContaining([fx.A.learner.id, learnerId]));
      expect(ids).not.toContain(fx.B.learner.id);
      const lh = await adminA.get('/api/admin/learning-hours').expect(200);
      expect(lh.body).toEqual(expect.objectContaining({ stats: expect.any(Object), learners: expect.any(Array) }));
      expect(lh.body.learners.map((l: { id: number }) => l.id)).not.toContain(fx.B.learner.id);
    });
  });

  describe('who may read insight', () => {
    it('refuses the learner-portal manager and a learner on every admin insight route', async () => {
      const manager = await signIn(app, fx.A.manager);
      const learner = await signIn(app, fx.A.learner);
      for (const who of [manager, learner]) {
        for (const p of ['/api/admin/dashboard', '/api/admin/analytics', '/api/admin/reports/options', '/api/admin/activity', '/api/admin/export']) {
          await who.get(p).expect(403);
        }
        await who.post('/api/admin/reports/group').send({ types: ['completion'] }).expect(403);
      }
    });

    it('a role without view_reports keeps the dashboard but not the reports; one without view_dashboard the reverse', async () => {
      const dashOnly = await limitedAdmin(app, adminA, fx.A, ['view_dashboard']);
      await dashOnly.agent.get('/api/admin/dashboard').expect(200);
      await dashOnly.agent.get('/api/admin/analytics').expect(403);
      await dashOnly.agent.post('/api/admin/reports/individual').send({ user_id: learnerId }).expect(403);
      await dashOnly.agent.get('/api/admin/activity').expect(403);

      const reportsOnly = await limitedAdmin(app, adminA, fx.A, ['view_reports']);
      await reportsOnly.agent.get('/api/admin/analytics').expect(200);
      await reportsOnly.agent.get('/api/admin/dashboard').expect(403);
      await reportsOnly.agent.get('/api/admin/dashboard/action-required').expect(403);
      await reportsOnly.agent.post('/api/admin/dashboard/nudge').send({ user_id: learnerId, course_id: course.id }).expect(403);
    });
  });

  describe('activity log (audit)', () => {
    it('lists change requests only, includes refusals, and stays inside the org', async () => {
      // A refused write: a tenant admin reaching a platform route.
      await adminA.post('/api/platform/incidents').send({ title: 'not allowed' }).expect(403);
      const refused = await waitFor(async () => {
        const r = await adminA.get('/api/admin/activity').query({ outcome: 'failure', limit: 100 });
        return r.body.entries?.find((e: { path: string; status_code: number }) => e.path === '/api/platform/incidents' && e.status_code === 403) ?? null;
      });
      expect(refused).toEqual(expect.objectContaining({ method: 'POST', outcome: 'failure', organization_id: fx.A.id, actor_user_id: fx.A.admin.id }));

      const all = await adminA.get('/api/admin/activity').query({ limit: 100 }).expect(200);
      expect(all.body.total).toBeGreaterThan(0);
      for (const e of all.body.entries) {
        expect(e.method).not.toBe('GET');
        expect(e.organization_id).toBe(fx.A.id);
        // Credentials never reach the log.
        expect(JSON.stringify(e.summary ?? {})).not.toMatch(/E2e-Passw0rd/);
      }
      expect(all.body.entries.some((e: { route: string; entity_id: number }) => e.route === '/api/admin/courses/:courseId/modules' && e.entity_id === course.id)).toBe(true);

      // The org id on the query is ignored for a tenant.
      const sneaky = await adminA.get('/api/admin/activity').query({ organization_id: fx.B.id, limit: 100 }).expect(200);
      for (const e of sneaky.body.entries) expect(e.organization_id).toBe(fx.A.id);

      const opts = await adminA.get('/api/admin/activity/options').expect(200);
      expect(opts.body.entities).toEqual(expect.arrayContaining(['courses']));
      expect(opts.body.actors.map((a: { id: number }) => a.id)).toContain(fx.A.admin.id);
      expect(opts.body.actors.map((a: { id: number }) => a.id)).not.toContain(fx.B.admin.id);
    });

    it('the platform sees every organization, can narrow to one, and a tenant admin cannot reach it', async () => {
      const sa = await signIn(app, fx.platform.admin);
      const all = await sa.get('/api/platform/activity').query({ limit: 100 }).expect(200);
      const orgs = new Set(all.body.entries.map((e: { organization_id: number }) => e.organization_id));
      expect(orgs.has(fx.A.id)).toBe(true);
      expect(orgs.has(fx.B.id)).toBe(true);
      const onlyB = await sa.get('/api/platform/activity').query({ organization_id: fx.B.id, limit: 100 }).expect(200);
      expect(onlyB.body.entries.length).toBeGreaterThan(0);
      for (const e of onlyB.body.entries) expect(e.organization_id).toBe(fx.B.id);
      const opts = await sa.get('/api/platform/activity/options').expect(200);
      expect(opts.body.organizations.map((o: { id: number }) => o.id)).toEqual(expect.arrayContaining([fx.A.id, fx.B.id]));
      await adminA.get('/api/platform/activity').expect(403);
      await adminA.get('/api/platform/activity/options').expect(403);
    });
  });
});
