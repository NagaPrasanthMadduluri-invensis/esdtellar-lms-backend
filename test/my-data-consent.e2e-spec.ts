/**
 * My Data and consent (BACKEND_STRUCTURE §10.38, §10.45): the summary, the
 * JSON export (headers, own data only, rate limited), the consent history,
 * correction / deletion / withdrawal requests, and the admin queue whose
 * withdrawal outcomes are written to the consent log.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, newPerson, signIn, type Agent } from './helpers';
import { limitedAdmin, waitFor } from './support/5';

describe('my data and consent', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
  });
  afterAll(async () => { await app.close(); });

  it('summarises the caller\'s own record with counts and states what is excluded', async () => {
    const r = await learnerA.get('/api/my-data').expect(200);
    expect(r.body.subject).toEqual(expect.objectContaining({ id: fx.A.learner.id, email: fx.A.learner.email, name: 'Learner Tester', organization_name: 'Org A E2E' }));
    expect(typeof r.body.counts).toBe('object');
    expect(r.body.note).toMatch(/SCORM/);
    // Every audience is a data subject: an admin and a trainer get their own.
    const a = await adminA.get('/api/my-data').expect(200);
    expect(a.body.subject.id).toBe(fx.A.admin.id);
    const t = await signIn(app, fx.A.trainer);
    expect((await t.get('/api/my-data').expect(200)).body.subject.id).toBe(fx.A.trainer.id);
    await anon(app).get('/api/my-data').expect(401);
  });

  it('exports JSON as an attachment with no password or reset token in it, and rate limits the export', async () => {
    const p = await newPerson(adminA, fx.A);
    const me = await signIn(app, p);
    await me.post('/api/auth/consent').send({ leaderboard_visible: true, recognition_emails: false }).expect((r) => expect(r.status).toBeLessThan(300));

    const r = await me.get('/api/my-data/export').expect(200);
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="my-data-.*\.json"$/);
    expect(r.headers['access-control-expose-headers']).toMatch(/Content-Disposition/);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(r.text);
    expect(body.account).toEqual(expect.objectContaining({ email: p.email }));
    expect(r.text).not.toMatch(/"password"/);
    expect(r.text).not.toMatch(/token_hash/);
    expect(r.text).not.toContain(fx.A.learner.email);
    expect(JSON.stringify(body.privacy?.consent_events ?? [])).toMatch(/acknowledged/);

    // Budget is 10 per hour per user; the first call above used one.
    for (let i = 0; i < 9; i++) await me.get('/api/my-data/export').expect(200);
    const limited = await me.get('/api/my-data/export').expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.body.message).toMatch(/several times/);
    // Per user: somebody else is unaffected.
    await learnerA.get('/api/my-data/export').expect(200);
  });

  it('shows the consent record: the acknowledged notice version and the history', async () => {
    const p = await newPerson(adminA, fx.A);
    const me = await signIn(app, p);
    const before = await me.get('/api/my-data/consent').expect(200);
    expect(before.body.notice).toEqual(expect.objectContaining({ acknowledged_version: null, up_to_date: false }));
    expect(before.body.events).toEqual([]);

    await me.post('/api/auth/consent').send({ leaderboard_visible: true, recognition_emails: true }).expect((r) => expect(r.status).toBeLessThan(300));
    await me.patch('/api/auth/email-preferences').send({ all_off: true }).expect(200);
    const after = await me.get('/api/my-data/consent').expect(200);
    expect(after.body.notice).toEqual(expect.objectContaining({ up_to_date: true, acknowledged_version: after.body.notice.current_version }));
    const events = after.body.events.map((e: { event: string }) => e.event);
    expect(events).toEqual(expect.arrayContaining(['acknowledged', 'choice_changed']));
  });

  it('files correction, deletion and withdrawal requests about the caller only, notifying admins and the subject', async () => {
    const p = await newPerson(adminA, fx.A);
    const me = await signIn(app, p);
    await me.post('/api/my-data/requests').send({ type: 'erase-everything' }).expect(400);
    await me.post('/api/my-data/requests').send({ type: 'correction', details: 'x'.repeat(451) }).expect(400);

    const c = await me.post('/api/my-data/requests').send({ type: 'correction', details: '  My course history is wrong  ', user_id: fx.A.learner.id }).expect(201);
    expect(c.body.request).toEqual(expect.objectContaining({ type: 'correction', status: 'open', details: 'My course history is wrong' }));
    const [row] = await dbQuery('SELECT user_id, organization_id FROM data_requests WHERE id = $1', [c.body.request.id]);
    expect(row).toEqual({ user_id: p.id, organization_id: fx.A.id });

    await me.post('/api/my-data/requests').send({ type: 'deletion' }).expect(201);
    const w = await me.post('/api/my-data/requests').send({ type: 'withdrawal', details: 'Stop processing' }).expect(201);
    const wev = await dbQuery("SELECT details FROM consent_events WHERE user_id = $1 AND event = 'withdrawal_requested'", [p.id]);
    expect(wev).toHaveLength(1);
    expect(wev[0].details.data_request_id).toBe(w.body.request.id);

    const mine = await me.get('/api/my-data/requests').expect(200);
    expect(mine.body.requests.map((r: { type: string }) => r.type).sort()).toEqual(['correction', 'deletion', 'withdrawal']);
    const other = await learnerA.get('/api/my-data/requests').expect(200);
    expect(other.body.requests.map((r: { id: number }) => r.id)).not.toContain(c.body.request.id);

    // Both sides are told (best-effort, so wait for it).
    const subj = await waitFor(
      () => dbQuery("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'data_request_submitted'", [p.id]),
      (r) => r.length >= 3,
    );
    expect(subj).toHaveLength(3);
    const adm = await waitFor(
      () => dbQuery("SELECT title FROM notifications WHERE user_id = $1 AND type = 'data_request_received' AND title LIKE $2", [fx.A.admin.id, `%${p.firstName}%`]),
      (r) => r.length >= 3,
    );
    expect(adm.map((n) => n.title).sort()).toEqual([
      `Data correction request from ${p.firstName} Temp`,
      `Data deletion request from ${p.firstName} Temp`,
      `Data consent withdrawal request from ${p.firstName} Temp`,
    ].sort());
    // Org B's admin hears nothing.
    expect(await dbQuery("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'data_request_received' AND title LIKE $2", [fx.B.admin.id, `%${p.firstName}%`])).toHaveLength(0);
  });

  describe('admin queue', () => {
    it('lists the org\'s requests with counts; another org and the wrong permission are refused', async () => {
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      const c = await me.post('/api/my-data/requests').send({ type: 'correction' }).expect(201);

      const list = await adminA.get('/api/admin/data-requests').expect(200);
      expect(list.body.requests.map((r: { id: number }) => r.id)).toContain(c.body.request.id);
      expect(list.body.counts).toEqual(expect.objectContaining({ open: expect.any(Number), total: expect.any(Number) }));
      expect(list.body.counts.total).toBe(['open', 'in_progress', 'resolved', 'rejected'].reduce((a, k) => a + list.body.counts[k], 0));
      const open = await adminA.get('/api/admin/data-requests').query({ status: 'open' }).expect(200);
      expect(open.body.requests.every((r: { status: string }) => r.status === 'open')).toBe(true);
      await adminA.get('/api/admin/data-requests').query({ status: 'weird' }).expect(400);

      const listB = await adminB.get('/api/admin/data-requests').expect(200);
      expect(listB.body.requests.map((r: { id: number }) => r.id)).not.toContain(c.body.request.id);
      await adminB.patch(`/api/admin/data-requests/${c.body.request.id}`).send({ status: 'resolved' }).expect(404);
      await me.get('/api/admin/data-requests').expect(403);
      await me.patch(`/api/admin/data-requests/${c.body.request.id}`).send({ status: 'resolved' }).expect(403);

      const viewer = (await limitedAdmin(app, adminA, fx.A, ['view_employees'])).agent;
      await viewer.get('/api/admin/data-requests').expect(200);
      await viewer.patch(`/api/admin/data-requests/${c.body.request.id}`).send({ status: 'resolved' }).expect(403);
      const nobody = (await limitedAdmin(app, adminA, fx.A, ['view_dashboard'])).agent;
      await nobody.get('/api/admin/data-requests').expect(403);

      const done = await adminA.patch(`/api/admin/data-requests/${c.body.request.id}`).send({ status: 'in_progress', admin_note: 'Looking' }).expect(200);
      expect(done.body.request).toEqual(expect.objectContaining({ status: 'in_progress' }));
      const [row] = await dbQuery('SELECT status, admin_note, handled_by FROM data_requests WHERE id = $1', [c.body.request.id]);
      expect(row).toEqual({ status: 'in_progress', admin_note: 'Looking', handled_by: fx.A.admin.id });
      const mine = await me.get('/api/my-data/requests').expect(200);
      expect(mine.body.requests[0].status).toBe('in_progress');
      // No consent event for a correction.
      expect(await dbQuery("SELECT 1 FROM consent_events WHERE user_id = $1 AND event LIKE 'withdrawal%'", [p.id])).toHaveLength(0);
    });

    it('writes withdrawal_resolved / withdrawal_rejected on the transition only', async () => {
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      const w1 = await me.post('/api/my-data/requests').send({ type: 'withdrawal' }).expect(201);
      const w2 = await me.post('/api/my-data/requests').send({ type: 'withdrawal' }).expect(201);
      const events = () => dbQuery<{ event: string; details: { data_request_id: number; handled_by: number } }>(
        "SELECT event, details FROM consent_events WHERE user_id = $1 AND event IN ('withdrawal_resolved','withdrawal_rejected') ORDER BY id", [p.id]);

      await adminA.patch(`/api/admin/data-requests/${w1.body.request.id}`).send({ status: 'in_progress' }).expect(200);
      expect(await events()).toHaveLength(0);
      await adminA.patch(`/api/admin/data-requests/${w1.body.request.id}`).send({ status: 'resolved' }).expect(200);
      // Re-saving the same closed status with a new note does not repeat it.
      await adminA.patch(`/api/admin/data-requests/${w1.body.request.id}`).send({ status: 'resolved', admin_note: 'Deactivated' }).expect(200);
      await adminA.patch(`/api/admin/data-requests/${w2.body.request.id}`).send({ status: 'rejected', admin_note: 'Contractual need' }).expect(200);

      const ev = await events();
      expect(ev.map((e) => e.event)).toEqual(['withdrawal_resolved', 'withdrawal_rejected']);
      expect(ev[0].details).toEqual(expect.objectContaining({ data_request_id: w1.body.request.id, handled_by: fx.A.admin.id }));
      expect(ev[1].details.data_request_id).toBe(w2.body.request.id);
      const history = await me.get('/api/my-data/consent').expect(200);
      expect(history.body.events.map((e: { event: string }) => e.event)).toEqual(expect.arrayContaining(['withdrawal_requested', 'withdrawal_resolved', 'withdrawal_rejected']));
    });
  });
});
