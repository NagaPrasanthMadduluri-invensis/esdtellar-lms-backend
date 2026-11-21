/**
 * Security incident register (CONTEXT.md §13): platform only. Create, options,
 * read, patch (assessment stamps the PDPC clock), notes, and notify-clients,
 * which writes a security_incident_notice to every admin of every affected
 * organization. The legal clocks are derived and sent on every read.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, signIn, uniq, type Agent } from './helpers';

type Deadline = { key: string; due_at: string | null; done_at: string | null; state: string };
const byKey = (d: Deadline[]) => Object.fromEntries(d.map((x) => [x.key, x]));
const HOUR = 3_600_000;

describe('security incidents', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let sa: Agent;
  let adminA: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    sa = await signIn(app, fx.platform.admin);
    adminA = await signIn(app, fx.A.admin);
  });
  afterAll(async () => { await app.close(); });

  it('is platform-only: a tenant admin and a learner get 403 on every route', async () => {
    const learner = await signIn(app, fx.A.learner);
    for (const who of [adminA, learner]) {
      await who.get('/api/platform/incidents').expect(403);
      await who.get('/api/platform/incidents/options').expect(403);
      await who.post('/api/platform/incidents').send({ title: 'x' }).expect(403);
    }
    const [{ n }] = await dbQuery<{ n: number }>("SELECT COUNT(*)::int AS n FROM security_incidents WHERE title = 'x'");
    expect(n).toBe(0);
  });

  it('offers the tenant organizations (never the platform org) as affected options', async () => {
    const r = await sa.get('/api/platform/incidents/options').expect(200);
    const ids = r.body.organizations.map((o: { id: number }) => o.id);
    expect(ids).toEqual(expect.arrayContaining([fx.A.id, fx.B.id]));
    expect(ids).not.toContain(fx.platform.id);
  });

  it('logs an incident with its clocks running from discovery, then assessment, notes and the client notice', async () => {
    const discovered = new Date(Date.now() - 2 * HOUR).toISOString();
    const title = uniq('Leak');
    const c = await sa.post('/api/platform/incidents').send({
      title, severity: 'high', discovered_at: discovered, data_categories: 'names, emails',
      individuals_affected: 12, organization_ids: [fx.A.id, fx.B.id],
    }).expect(201);
    const inc = c.body.incident;
    expect(inc).toEqual(expect.objectContaining({ title, severity: 'high', status: 'open', assessment: 'undecided', individuals_affected: 12 }));
    expect(inc.ref_no).toBeTruthy();
    expect(inc.organizations.map((o: { id: number }) => o.id).sort()).toEqual([fx.A.id, fx.B.id].sort());
    expect(inc.events.map((e: { kind: string }) => e.kind)).toContain('created');

    // Clocks: assessment 30 days, clients 24 h, regulator 72 h, all from discovery.
    const d = byKey(inc.deadlines);
    expect(Object.keys(d).sort()).toEqual(['assessment', 'clients', 'regulator_72h']);
    const t0 = Date.parse(discovered);
    expect(Date.parse(d.clients.due_at!)).toBe(t0 + 24 * HOUR);
    expect(Date.parse(d.regulator_72h.due_at!)).toBe(t0 + 72 * HOUR);
    expect(Date.parse(d.assessment.due_at!)).toBe(t0 + 30 * 24 * HOUR);
    expect(d.clients.state).toBe('due_soon');
    expect(inc.next_deadline.key).toBe('clients');

    const list = await sa.get('/api/platform/incidents').expect(200);
    expect(list.body.incidents.map((i: { id: number }) => i.id)).toContain(inc.id);
    expect(list.body.counts.open).toBeGreaterThanOrEqual(1);
    expect(list.body.incidents.find((i: { id: number }) => i.id === inc.id).deadlines.length).toBe(3);

    // Assessed notifiable: the PDPC clock (3 days from the assessment) and individuals appear.
    const p = await sa.patch(`/api/platform/incidents/${inc.id}`).send({ assessment: 'notifiable', status: 'assessing' }).expect(200);
    expect(p.body.incident.assessment).toBe('notifiable');
    expect(p.body.incident.status).toBe('assessing');
    expect(p.body.incident.assessed_at).toBeTruthy();
    const d2 = byKey(p.body.incident.deadlines);
    expect(d2.assessment.state).toBe('done');
    expect(d2.regulator_pdpa).toBeTruthy();
    expect(d2.individuals.due_at).toBeNull();
    const assessedAt = Date.parse(String(p.body.incident.assessed_at).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    expect(Math.abs(Date.parse(d2.regulator_pdpa.due_at!) - (assessedAt + 3 * 24 * HOUR))).toBeLessThan(1000);
    expect(p.body.incident.events.some((e: { kind: string; note: string }) => e.kind === 'updated' && /notifiable/.test(e.note))).toBe(true);

    const n = await sa.post(`/api/platform/incidents/${inc.id}/notes`).send({ note: 'Rotated keys' }).expect(201);
    expect(n.body.incident.events.some((e: { kind: string; note: string }) => e.kind === 'note' && e.note === 'Rotated keys')).toBe(true);
    await sa.post(`/api/platform/incidents/${inc.id}/notes`).send({ note: '' }).expect(400);

    // Notify clients: every active admin-portal user of A and B.
    const admins = await dbQuery<{ id: number }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.organization_id = ANY($1) AND u.is_active = 1 AND r.portal = 'admin'`, [[fx.A.id, fx.B.id]]);
    const nc = await sa.post(`/api/platform/incidents/${inc.id}/notify-clients`).send({ message: 'We found an issue.' }).expect(200);
    expect(nc.body.notified).toBe(admins.length);
    expect(nc.body.incident.clients_notified_at).toBeTruthy();
    expect(byKey(nc.body.incident.deadlines).clients.state).toBe('done');
    expect(nc.body.incident.events.some((e: { kind: string }) => e.kind === 'clients_notified')).toBe(true);

    const rows = await dbQuery<{ user_id: number; organization_id: number }>(
      "SELECT user_id, organization_id FROM notifications WHERE type = 'security_incident_notice' AND subject_id = $1", [inc.id]);
    expect(rows.map((r) => r.user_id).sort()).toEqual(admins.map((a) => a.id).sort());
    expect(rows.find((r) => r.user_id === fx.A.admin.id)?.organization_id).toBe(fx.A.id);
    expect(rows.find((r) => r.user_id === fx.B.admin.id)?.organization_id).toBe(fx.B.id);
    // No learner was told.
    expect(rows.map((r) => r.user_id)).not.toContain(fx.A.learner.id);
    // It is mailed as well (the type cannot be switched off).
    const mail = await dbQuery("SELECT to_email FROM email_outbox WHERE type = 'security_incident_notice' AND to_email = $1", [fx.A.admin.email]);
    expect(mail.length).toBeGreaterThan(0);

    // A second notice keeps the first notified-at time.
    const first = nc.body.incident.clients_notified_at;
    const again = await sa.post(`/api/platform/incidents/${inc.id}/notify-clients`).send({ message: 'Update.' }).expect(200);
    expect(again.body.incident.clients_notified_at).toBe(first);

    // Regulator notified: both regulator clocks close.
    const reg = await sa.patch(`/api/platform/incidents/${inc.id}`).send({ regulator_notified_at: new Date().toISOString(), regulator_reference: 'PDPC-1' }).expect(200);
    const d3 = byKey(reg.body.incident.deadlines);
    expect(d3.regulator_72h.state).toBe('done');
    expect(d3.regulator_pdpa.state).toBe('done');

    const closed = await sa.patch(`/api/platform/incidents/${inc.id}`).send({ status: 'closed' }).expect(200);
    expect(closed.body.incident.closed_at).toBeTruthy();
    expect(closed.body.incident.next_deadline).toBeNull();

    const got = await sa.get(`/api/platform/incidents/${inc.id}`).expect(200);
    expect(got.body.incident.regulator_reference).toBe('PDPC-1');
  });

  it('an incident assessed not notifiable has no regulator clocks', async () => {
    const c = await sa.post('/api/platform/incidents').send({ title: uniq('Minor') }).expect(201);
    expect(c.body.incident.severity).toBe('medium');
    // No organizations named: no client clock.
    expect(Object.keys(byKey(c.body.incident.deadlines)).sort()).toEqual(['assessment', 'regulator_72h']);
    const p = await sa.patch(`/api/platform/incidents/${c.body.incident.id}`).send({ assessment: 'not_notifiable' }).expect(200);
    expect(Object.keys(byKey(p.body.incident.deadlines))).toEqual(['assessment']);
  });

  it('refuses a future discovery time, a notice with no affected organizations, bad input and unknown ids', async () => {
    await sa.post('/api/platform/incidents').send({ title: 'Future', discovered_at: new Date(Date.now() + 24 * HOUR).toISOString() }).expect(422);
    await sa.post('/api/platform/incidents').send({ title: '' }).expect(400);
    await sa.post('/api/platform/incidents').send({ title: 'x', severity: 'apocalyptic' }).expect(400);
    const none = (await sa.post('/api/platform/incidents').send({ title: uniq('NoOrgs') }).expect(201)).body.incident;
    await sa.post(`/api/platform/incidents/${none.id}/notify-clients`).send({ message: 'hello' }).expect(422);
    await sa.get('/api/platform/incidents/999999').expect(404);
    await sa.patch('/api/platform/incidents/999999').send({ title: 'y' }).expect(404);
    await sa.post('/api/platform/incidents/999999/notes').send({ note: 'y' }).expect(404);
  });
});
