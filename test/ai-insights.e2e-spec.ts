/**
 * AI Insights (CONTEXT.md §10.54, §10.56) against the fake OpenRouter
 * (test/fake-ai.js). A refresh stores the insight; it is rate limited to 5 an
 * hour per user; what leaves the server carries no person's name or email and
 * is fenced by the tenant isolation directive; the admin intelligence read is
 * real data and needs view_reports.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { TENANT_ISOLATION_DIRECTIVE } from '@/modules/ai/ai-tenant';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, type Agent, type Person } from './helpers';
import { limitedAdmin, makeCourse } from './support/4';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fakeAi = require('./fake-ai') as { requests: () => { url: string; headers: Record<string, string>; body: { messages?: { role: string; content: string }[] } }[] };

/** Everything the server sent to the model since request index `since`. */
function sentSince(since: number) {
  return fakeAi.requests().slice(since);
}

describe('ai insights', () => {
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
    const course = await makeCourse(adminA, { assign: [p.id, fx.A.learner.id] });
    await me.post(`/api/learner/lessons/${course.lessons[0].publicId}/complete`).expect(200);
  });
  afterAll(async () => { await app.close(); });

  /** The people whose names or emails must never reach the model. */
  const people = () => [p, fx.A.learner, fx.A.learner2, fx.A.manager, fx.A.trainer, fx.A.admin];

  function assertNoPii(reqs: ReturnType<typeof sentSince>) {
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) {
      const text = JSON.stringify(r.body);
      expect(text).toContain(TENANT_ISOLATION_DIRECTIVE);
      for (const person of people()) {
        expect(text).not.toContain(person.email);
        expect(text).not.toContain(person.firstName === 'Learner' || person.firstName === 'Manager' || person.firstName === 'Trainer' ? `${person.firstName} Tester` : person.firstName);
      }
      expect(text).not.toMatch(/@org-[ab]\.e2e\.test/);
      expect(text).not.toMatch(/\bTester\b|\bTemp\b|\bOwner\b/);
      // No tenant identifier rides in the headers either.
      expect(JSON.stringify(r.headers)).not.toMatch(/org-a|Org A/i);
    }
  }

  describe('learner', () => {
    it('reads an empty insight with real-data charts before any generation', async () => {
      const r = await me.get('/api/learner/ai/insights').expect(200);
      expect(r.body.enabled).toBe(true);
      expect(r.body.insight).toBeNull();
      expect(r.body.charts).toEqual(expect.objectContaining({ courseStatus: expect.any(Array), totals: expect.any(Object) }));

      const c = await me.get('/api/learner/ai/charts').expect(200);
      const completed = c.body.courseStatus.find((s: { status: string }) => s.status === 'Completed');
      expect(completed.value).toBe(1);
    });

    it('refresh calls the model once, stores the insight, and sends no PII but the isolation fence', async () => {
      const since = fakeAi.requests().length;
      const r = await me.post('/api/learner/ai/insights/refresh').expect(200);
      expect(r.body).toEqual(expect.objectContaining({ enabled: true, error: null }));
      expect(r.body.insight.payload).toBeDefined();

      const rows = await dbQuery("SELECT organization_id, kind, payload FROM ai_insights WHERE subject_type = 'learner' AND subject_id = $1", [p.id]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].organization_id).toBe(fx.A.id);

      const sent = sentSince(since);
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toMatch(/chat\/completions/);
      assertNoPii(sent);

      const read = await me.get('/api/learner/ai/insights').expect(200);
      expect(read.body.insight).toEqual(expect.objectContaining({ payload: expect.any(Object), generatedAt: expect.any(String) }));
      // Another learner does not see it.
      const other = await signIn(app, fx.A.learner2);
      const o = await other.get('/api/learner/ai/insights').expect(200);
      expect(o.body.insight).toBeNull();
    });

    it('a lens is read, generated and stored on its own kind; an unknown lens is 400', async () => {
      const empty = await me.get('/api/learner/ai/lens/skill_plan').expect(200);
      expect(empty.body.insight ?? null).toBeNull();
      const since = fakeAi.requests().length;
      const r = await me.post('/api/learner/ai/lens/course_recommendations/refresh').expect(200);
      expect(r.body).toEqual(expect.objectContaining({ enabled: true, error: null }));
      assertNoPii(sentSince(since));
      const got = await me.get('/api/learner/ai/lens/course_recommendations').expect(200);
      expect(got.body.insight).toEqual(expect.objectContaining({ payload: expect.any(Object) }));
      const kinds = (await dbQuery("SELECT kind FROM ai_insights WHERE subject_type = 'learner' AND subject_id = $1", [p.id])).map((k) => k.kind);
      expect(new Set(kinds).size).toBeGreaterThanOrEqual(2);

      await me.get('/api/learner/ai/lens/horoscope').expect(400);
      await me.post('/api/learner/ai/lens/horoscope/refresh').expect(400);
    });

    it('limits a learner to 5 refreshes an hour (429 with Retry-After)', async () => {
      const q = await signIn(app, await newPerson(adminA, fx.A));
      for (let i = 0; i < 5; i++) await q.post('/api/learner/ai/insights/refresh').expect(200);
      const sixth = await q.post('/api/learner/ai/insights/refresh').expect(429);
      expect(sixth.headers['retry-after']).toBeDefined();
      // The lens budget is separate.
      await q.post('/api/learner/ai/lens/skill_plan/refresh').expect(200);
    });

    it('an admin cannot use learner AI routes', async () => {
      await adminA.get('/api/learner/ai/insights').expect(403);
    });
  });

  // CONTEXT.md §10.54: "No tenant identifier leaves the box ... the org id stays
  // internal (logs/assert)".
  it('the AI prompt body carries no tenant organizationId', async () => {
    const since = fakeAi.requests().length;
    await me.post('/api/learner/ai/lens/skill_plan/refresh').expect(200);
    for (const r of sentSince(since)) expect(JSON.stringify(r.body)).not.toMatch(/organizationId/);
  });

  describe('admin', () => {
    it('refresh stores the org briefing, with no names or emails in the prompt', async () => {
      const before = await adminA.get('/api/admin/ai/insights').expect(200);
      expect(before.body.enabled).toBe(true);

      const since = fakeAi.requests().length;
      const r = await adminA.post('/api/admin/ai/insights/refresh').expect(200);
      expect(r.body.error ?? null).toBeNull();
      const sent = sentSince(since);
      expect(sent).toHaveLength(1);
      assertNoPii(sent);

      const rows = await dbQuery("SELECT organization_id FROM ai_insights WHERE subject_type = 'org' AND organization_id = $1", [fx.A.id]);
      expect(rows).toHaveLength(1);
      const read = await adminA.get('/api/admin/ai/insights').expect(200);
      expect(read.body.insight).toEqual(expect.objectContaining({ payload: expect.any(Object) }));

      // Org B's briefing is not org A's.
      const adminB = await signIn(app, fx.B.admin);
      const rb = await adminB.get('/api/admin/ai/insights').expect(200);
      expect(rb.body.insight ?? null).toBeNull();
    });

    it('intelligence returns real-data sections', async () => {
      const r = await adminA.get('/api/admin/ai/intelligence').expect(200);
      for (const k of ['healthScore', 'riskRadar', 'inactivity', 'courseEffectiveness', 'skillIntelligence', 'departments', 'statusBreakdown']) {
        expect(r.body).toHaveProperty(k);
      }
      expect(JSON.stringify(r.body)).not.toContain(fx.A.learner.email);
    });

    it('all three admin routes need view_reports; learners are refused', async () => {
      const { agent } = await limitedAdmin(app, adminA, fx.A, ['manage_courses']);
      await agent.get('/api/admin/ai/insights').expect(403);
      await agent.get('/api/admin/ai/intelligence').expect(403);
      await agent.post('/api/admin/ai/insights/refresh').expect(403);
      await me.get('/api/admin/ai/intelligence').expect(403);
    });
  });
});
