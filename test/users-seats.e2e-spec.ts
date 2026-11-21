/**
 * Organizations and people (CONTEXT.md §2): the people list, Add / Edit /
 * Deactivate / Delete, Reporting line refusals, Bulk import, Workforce lists
 * (platform-curated, tenant-read), the geo reference data, and Seats (limit,
 * enforcement, Seat requests answered by the platform).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, lastOutbox, newPerson, signIn, uniq, type Agent } from './helpers';
import { ok, provisionOrg, type ThrowawayOrg } from './support/1';

async function eventually<T>(fn: () => Promise<T | undefined>, ms = 1500): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('users and seats', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let managerA: Agent;
  let sa: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    managerA = await signIn(app, fx.A.manager);
    sa = await signIn(app, fx.platform.admin);
  });
  afterAll(async () => { await app.close(); });

  describe('people lists', () => {
    it('GET /admin/users lists only this organization learners; a learner and a manager are refused', async () => {
      const res = await adminA.get('/api/admin/users').expect(200);
      const ids = res.body.users.map((u: { id: number }) => u.id);
      expect(ids).toEqual(expect.arrayContaining([fx.A.learner.id, fx.A.learner2.id]));
      expect(ids).not.toContain(fx.B.learner.id);
      expect(ids).not.toContain(fx.A.admin.id);
      expect(JSON.stringify(res.body)).not.toMatch(/password/i);
      await learnerA.get('/api/admin/users').expect(403);
      await managerA.get('/api/admin/users').expect(403);
    });

    it('GET /admin/employees carries progress for each learner', async () => {
      const res = await adminA.get('/api/admin/employees').expect(200);
      const row = res.body.employees.find((e: { id: number }) => e.id === fx.A.learner.id);
      expect(row).toEqual(expect.objectContaining({ status: expect.any(String), progress: expect.any(Number) }));
      expect(res.body.employees.map((e: { id: number }) => e.id)).not.toContain(fx.B.learner.id);
      await learnerA.get('/api/admin/employees').expect(403);
    });

    it('GET /admin/users/directory pages every account with org-wide stats; only learners are manageable', async () => {
      const res = await adminA.get('/api/admin/users/directory').query({ limit: 100 }).expect(200);
      expect(res.body.limit).toBe(100);
      expect(res.body.stats.admins).toBeGreaterThanOrEqual(1);
      expect(res.body.stats.trainers).toBeGreaterThanOrEqual(1);
      const byId = new Map(res.body.users.map((u: { id: number }) => [u.id, u]));
      expect(byId.get(fx.A.admin.id)).toEqual(expect.objectContaining({ can_manage: false }));
      expect(byId.get(fx.A.learner.id)).toEqual(expect.objectContaining({ can_manage: true, manager_id: fx.A.manager.id }));
      expect(byId.get(fx.A.manager.id)).toEqual(expect.objectContaining({ reports_count: 2 }));
      expect(byId.has(fx.B.learner.id)).toBe(false);
      const page = await adminA.get('/api/admin/users/directory').query({ limit: 1, offset: 0 }).expect(200);
      expect(page.body.users).toHaveLength(1);
      expect(page.body.has_more).toBe(true);
      await adminA.get('/api/admin/users/directory').query({ limit: 500 }).expect(400);
    });

    it('GET /admin/users/people is the whole org identity list for the manager picker', async () => {
      const res = await adminA.get('/api/admin/users/people').expect(200);
      const ids = res.body.people.map((p: { id: number }) => p.id);
      expect(ids).toEqual(expect.arrayContaining([fx.A.admin.id, fx.A.manager.id, fx.A.trainer.id]));
      expect(ids).not.toContain(fx.B.admin.id);
      await managerA.get('/api/admin/users/people').expect(403);
    });

    it('GET /admin/users/template is a spreadsheet download', async () => {
      const res = await adminA.get('/api/admin/users/template').buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(String(res.headers['content-disposition'])).toMatch(/Learner_Upload_Template\.xlsx/);
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      await learnerA.get('/api/admin/users/template').expect(403);
    });

    it('GET /admin/users/:id returns a learner report; another org gets 404', async () => {
      const res = await adminA.get(`/api/admin/users/${fx.A.learner.id}`).expect(200);
      expect(res.body.user.id).toBe(fx.A.learner.id);
      expect(res.body.summary).toEqual(expect.objectContaining({ coursesAssigned: expect.any(Number) }));
      await adminB.get(`/api/admin/users/${fx.A.learner.id}`).expect(404);
    });
  });

  describe('add, edit, deactivate, delete', () => {
    it('adds a learner with a manager, queues their welcome, refuses a duplicate address and a foreign manager', async () => {
      const email = `${uniq('add')}@org-a.e2e.test`;
      const res = await adminA.post('/api/admin/users')
        .send({ first_name: 'Added', last_name: 'Person', email, department: 'Sales', manager_id: fx.A.manager.id, role_id: fx.A.roles.learner })
        .expect(201);
      const id = res.body.user.id;
      const [row] = await dbQuery('SELECT organization_id, role, manager_id, department FROM users WHERE id = $1', [id]);
      expect(row).toEqual({ organization_id: fx.A.id, role: 'learner', manager_id: fx.A.manager.id, department: 'Sales' });
      const welcome = await eventually(() => lastOutbox(email, 'welcome'));
      expect(welcome).toBeDefined();
      expect(welcome!.link).toMatch(/token=/);

      await adminA.post('/api/admin/users').send({ first_name: 'D', last_name: 'D', email: email.toUpperCase() }).expect(409);
      // One email, one account across every organization.
      await adminB.post('/api/admin/users').send({ first_name: 'D', last_name: 'D', email }).expect(409);
      // A manager in another organization looks like nobody.
      await adminB.post('/api/admin/users').send({ first_name: 'X', last_name: 'Y', email: `${uniq('x')}@org-b.e2e.test`, manager_id: fx.A.manager.id }).expect(404);
      // A role id from another org is refused, not used.
      await adminB.post('/api/admin/users').send({ first_name: 'X', last_name: 'Y', email: `${uniq('x')}@org-b.e2e.test`, role_id: fx.A.roles.learner }).expect(404);
      await managerA.post('/api/admin/users').send({ first_name: 'X', last_name: 'Y', email: `${uniq('x')}@org-a.e2e.test` }).expect(403);
    });

    it('edits a learner (PUT) and refuses a self-manager, a reporting loop, and editing an admin', async () => {
      const p = await newPerson(adminA, fx.A);
      const q = await newPerson(adminA, fx.A, 'learner', { manager_id: p.id });
      const base = { first_name: p.firstName, last_name: 'Edited', email: p.email };
      await adminA.put(`/api/admin/users/${p.id}`).send({ ...base, department: 'Finance', job_role: 'Analyst' }).expect(200);
      const [row] = await dbQuery('SELECT last_name, department, job_role FROM users WHERE id = $1', [p.id]);
      expect(row).toEqual({ last_name: 'Edited', department: 'Finance', job_role: 'Analyst' });

      await adminA.put(`/api/admin/users/${p.id}`).send({ ...base, manager_id: p.id }).expect(422);
      // q reports to p, so p reporting to q would close a loop.
      await adminA.put(`/api/admin/users/${p.id}`).send({ ...base, manager_id: q.id }).expect(422);
      await adminA.put(`/api/admin/users/${p.id}`).send({ ...base, email: fx.A.learner.email }).expect(409);
      await adminA.put(`/api/admin/users/${fx.A.admin.id}`).send({ first_name: 'A', last_name: 'B', email: fx.A.admin.email }).expect(403);
      await adminB.put(`/api/admin/users/${p.id}`).send(base).expect(404);
      await learnerA.put(`/api/admin/users/${p.id}`).send(base).expect(403);
    });

    it('deactivates (PATCH) and reactivates, stamping and clearing the retention clock; deactivated people cannot sign in', async () => {
      const p = await newPerson(adminA, fx.A);
      const res = await adminA.patch(`/api/admin/users/${p.id}`).send({ is_active: false }).expect(200);
      expect(res.body.user.is_active).toBe(false);
      let [row] = await dbQuery('SELECT is_active, deactivated_at FROM users WHERE id = $1', [p.id]);
      expect(row.is_active).toBe(0);
      expect(row.deactivated_at).not.toBeNull();
      await expect(signIn(app, p)).rejects.toThrow(/login failed/);

      await adminA.patch(`/api/admin/users/${p.id}`).send({ is_active: true }).expect(200);
      [row] = await dbQuery('SELECT is_active, deactivated_at FROM users WHERE id = $1', [p.id]);
      expect(row).toEqual({ is_active: 1, deactivated_at: null });
      await signIn(app, p);

      await adminA.patch(`/api/admin/users/${p.id}`).send({ is_active: 'no' }).expect(400);
      await adminA.patch(`/api/admin/users/${fx.A.admin.id}`).send({ is_active: false }).expect(403);
      await adminB.patch(`/api/admin/users/${p.id}`).send({ is_active: false }).expect(404);
    });

    it('deletes a learner (DELETE) but never an admin', async () => {
      const p = await newPerson(adminA, fx.A);
      await adminB.delete(`/api/admin/users/${p.id}`).expect(404);
      await managerA.delete(`/api/admin/users/${p.id}`).expect(403);
      await adminA.delete(`/api/admin/users/${p.id}`).expect(200);
      expect(await dbQuery('SELECT id FROM users WHERE id = $1', [p.id])).toHaveLength(0);
      await adminA.delete(`/api/admin/users/${fx.A.admin.id}`).expect(403);
    });
  });

  describe('bulk import', () => {
    it('creates good rows, fails a row naming an unknown manager, and resolves a manager created earlier in the same file', async () => {
      const boss = `${uniq('boss')}@org-a.e2e.test`;
      const rep = `${uniq('rep')}@org-a.e2e.test`;
      const bad = `${uniq('bad')}@org-a.e2e.test`;
      const res = await adminA.post('/api/admin/users/bulk').send({
        users: [
          { first_name: 'Boss', last_name: 'Bulk', email: boss, department: 'Ops', manager: fx.A.manager.email },
          { first_name: 'Rep', last_name: 'Bulk', email: rep, manager: boss },
          { first_name: 'Bad', last_name: 'Bulk', email: bad, manager: 'nobody@nowhere.test' },
        ],
      }).expect(201);
      expect(res.body).toEqual(expect.objectContaining({ created: 2, total: 3, welcome_emails_requested: true, welcome_emails_queued: 2 }));
      expect(res.body.failed).toHaveLength(1);
      expect(res.body.failed[0].email).toBe(bad);
      const rows = await dbQuery('SELECT email, manager_id, organization_id FROM users WHERE email = ANY($1)', [[boss, rep, bad]]);
      const by = Object.fromEntries(rows.map((r) => [r.email, r]));
      expect(by[bad]).toBeUndefined();
      expect(by[boss].manager_id).toBe(fx.A.manager.id);
      const [bossRow] = await dbQuery('SELECT id FROM users WHERE email = $1', [boss]);
      expect(by[rep].manager_id).toBe(bossRow.id);
      expect(by[rep].organization_id).toBe(fx.A.id);
      expect(await lastOutbox(rep, 'welcome')).toBeDefined();
    });

    it('answers 422 when nothing in the file could be created, and refuses a manager in another org', async () => {
      const res = await adminB.post('/api/admin/users/bulk').send({
        users: [{ first_name: 'X', last_name: 'Y', email: `${uniq('x')}@org-b.e2e.test`, manager: fx.A.manager.email }],
      }).expect(422);
      expect(res.body.created).toBe(0);
      await adminA.post('/api/admin/users/bulk').send({ users: [] }).expect(400);
      await managerA.post('/api/admin/users/bulk').send({ users: [{ email: 'a@b.test' }] }).expect(403);
    });
  });

  describe('workforce lists and geo reference data', () => {
    let T: ThrowawayOrg;
    beforeAll(async () => { T = await provisionOrg(app, sa); });

    it('the platform curates a tenant Locations and Job levels; the tenant reads only active ones and forms use them', async () => {
      const put = await sa.put(`/api/platform/organizations/${T.id}/options/locations`).send({
        locations: [{ name: 'Pune', country_code: 'IN', country_name: 'India', state_name: 'Maharashtra' }, { name: 'Dubai', country_code: 'AE' }, { name: 'pune' }],
      }).expect(200);
      expect(put.body.locations.filter((l: { is_active: boolean }) => l.is_active).map((l: { name: string }) => l.name)).toEqual(['Pune', 'Dubai']);
      await sa.put(`/api/platform/organizations/${T.id}/options/job-levels`).send({ job_levels: ['Junior', 'Senior', ' '] }).expect(200);

      // Replacing the list turns the dropped entry off, never deletes it.
      await sa.put(`/api/platform/organizations/${T.id}/options/locations`).send({ locations: [{ name: 'Pune' }] }).expect(200);
      const all = await sa.get(`/api/platform/organizations/${T.id}/options`).expect(200);
      expect(all.body.locations.find((l: { name: string }) => l.name === 'Dubai').is_active).toBe(false);
      const active = await sa.get(`/api/platform/organizations/${T.id}/options`).query({ active: '1' }).expect(200);
      expect(active.body.locations.map((l: { name: string }) => l.name)).toEqual(['Pune']);
      expect(active.body.job_levels.map((j: { name: string }) => j.name)).toEqual(['Junior', 'Senior']);

      const mine = await T.adminAgent.get('/api/admin/organization/options').expect(200);
      expect(mine.body.locations.map((l: { name: string }) => l.name)).toEqual(['Pune']);

      // A value off the list is refused; the list's own spelling is stored.
      await T.adminAgent.post('/api/admin/users').send({ first_name: 'L', last_name: 'X', email: `${uniq('l')}@${T.slug}.e2e.test`, location: 'Dubai' }).expect(422);
      const email = `${uniq('l')}@${T.slug}.e2e.test`;
      await T.adminAgent.post('/api/admin/users').send({ first_name: 'L', last_name: 'X', email, location: 'pune', job_level: 'senior' }).expect(201);
      const [row] = await dbQuery('SELECT location, job_level FROM users WHERE email = $1', [email]);
      expect(row).toEqual({ location: 'Pune', job_level: 'Senior' });

      // Tenants cannot curate, not even their own.
      await T.adminAgent.put(`/api/platform/organizations/${T.id}/options/locations`).send({ locations: [] }).expect(403);
      await adminA.get(`/api/platform/organizations/${fx.A.id}/options`).expect(403);
      await learnerA.get('/api/admin/organization/options').expect(403);
    });

    it('serves industries, countries and a country cities to the platform only', async () => {
      const ind = await sa.get('/api/platform/geo/industries').expect(200);
      expect(ind.body.industries.length).toBeGreaterThan(5);
      const countries = await sa.get('/api/platform/geo/countries').expect(200);
      expect(countries.body.countries).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'IN', name: 'India' })]));
      const cities = await sa.get('/api/platform/geo/countries/in/cities').expect(200);
      expect(cities.body.country).toEqual({ code: 'IN', name: 'India' });
      const names = cities.body.cities.map((c: { name: string }) => c.name);
      expect(names).toContain('Pune');
      expect(new Set(names.map((n: string) => n.toLowerCase())).size).toBe(names.length);
      await sa.get('/api/platform/geo/countries/ZZ/cities').expect(404);
      await adminA.get('/api/platform/geo/countries').expect(403);
      await adminA.get('/api/platform/geo/industries').expect(403);
    });
  });

  describe('seats', () => {
    let S: ThrowawayOrg;
    let learner: Agent;
    beforeAll(async () => {
      S = await provisionOrg(app, sa);
      // Trainer role (no perm bump), for a seat-free account below.
      await S.adminAgent.post('/api/admin/roles/trainer').expect(200);
      const roles = await dbQuery<{ id: number; key: string }>('SELECT id, key FROM roles WHERE organization_id = $1', [S.id]);
      S.roles = Object.fromEntries(roles.map((r) => [r.key, r.id]));
    });

    it('the platform sets a limit directly; the tenant sees it read-only and adding past it is refused (409)', async () => {
      const set = await sa.put(`/api/platform/seats/organizations/${S.id}`).send({ seat_limit: 1 }).expect(200);
      expect(set.body).toEqual({ organization_id: S.id, seat_limit: 1 });
      let usage = await S.adminAgent.get('/api/admin/seats').expect(200);
      expect(usage.body).toEqual(expect.objectContaining({ limit: 1, used: 0, remaining: 1, is_full: false }));

      const p = await newPerson(S.adminAgent, S);
      learner = await signIn(app, p);
      usage = await S.adminAgent.get('/api/admin/seats').expect(200);
      expect(usage.body).toEqual(expect.objectContaining({ used: 1, remaining: 0, is_full: true }));
      expect(usage.body.breakdown).toEqual(expect.objectContaining({ admins: 1, learners: 1 }));

      const refused = await S.adminAgent.post('/api/admin/users').send({ first_name: 'O', last_name: 'V', email: `${uniq('o')}@${S.slug}.e2e.test` });
      expect(refused.status).toBe(409);
      expect(refused.body.message).toMatch(/All 1 seats are in use/);

      // A trainer uses no seat.
      await newPerson(S.adminAgent, S, 'trainer');
      // Deactivating frees the seat; reactivating takes it again.
      await S.adminAgent.patch(`/api/admin/users/${p.id}`).send({ is_active: false }).expect(200);
      const q = await newPerson(S.adminAgent, S);
      await S.adminAgent.patch(`/api/admin/users/${p.id}`).send({ is_active: true }).expect(409);
      await S.adminAgent.patch(`/api/admin/users/${q.id}`).send({ is_active: false }).expect(200);
      await S.adminAgent.patch(`/api/admin/users/${p.id}`).send({ is_active: true }).expect(200);

      await learner.get('/api/admin/seats').expect(403);
      await S.adminAgent.put(`/api/platform/seats/organizations/${S.id}`).send({ seat_limit: 99 }).expect(403);
      await sa.put('/api/platform/seats/organizations/99999999').send({ seat_limit: 5 }).expect(404);
    });

    it('an Admin asks for more seats; the platform approves fewer, which WRITES the limit, and the tenant is told', async () => {
      await S.adminAgent.post('/api/admin/seats/requests').send({ requested_seats: 1 }).expect(422);
      const created = await S.adminAgent.post('/api/admin/seats/requests').send({ requested_seats: 10, reason: 'Growing team' }).expect(201);
      const id = created.body.request.id;
      await S.adminAgent.post('/api/admin/seats/requests').send({ requested_seats: 12 }).expect(409);

      const mine = await S.adminAgent.get('/api/admin/seats/requests').expect(200);
      expect(mine.body.requests.map((r: { id: number }) => r.id)).toContain(id);
      expect(mine.body.seats.limit).toBe(1);
      // Another tenant never sees it.
      const other = await adminA.get('/api/admin/seats/requests').expect(200);
      expect(other.body.requests.map((r: { id: number }) => r.id)).not.toContain(id);

      const queue = await sa.get('/api/platform/seats/requests').query({ status: 'pending' }).expect(200);
      const row = queue.body.requests.find((r: { id: number }) => r.id === id);
      expect(row).toEqual(expect.objectContaining({ organization_name: S.name, requested_seats: 10, current_used: 1, contact_email: S.admin.email }));
      expect(queue.body.counts.pending).toBeGreaterThanOrEqual(1);
      const pf = await dbQuery("SELECT 1 FROM notifications WHERE type = 'seat_requested' AND subject_id = $1 AND organization_id = $2", [id, fx.platform.id]);
      expect(pf.length).toBeGreaterThanOrEqual(1);

      const ans = await sa.patch(`/api/platform/seats/requests/${id}`).send({ status: 'approved', approved_seats: 4, response_note: 'Four for now' }).expect(200);
      expect(ans.body.request).toEqual(expect.objectContaining({ status: 'approved', approved_seats: 4 }));
      const [org] = await dbQuery('SELECT seat_limit FROM organizations WHERE id = $1', [S.id]);
      expect(org.seat_limit).toBe(4);
      expect((await S.adminAgent.get('/api/admin/seats').expect(200)).body.limit).toBe(4);
      const told = await eventually(async () => (await dbQuery("SELECT title FROM notifications WHERE type = 'seat_request_answered' AND user_id = $1 AND subject_id = $2", [S.admin.id, id]))[0]);
      expect(told?.title).toMatch(/4 seats/);

      await adminA.patch(`/api/platform/seats/requests/${id}`).send({ status: 'declined' }).expect(403);
      await sa.patch('/api/platform/seats/requests/99999999').send({ status: 'declined' }).expect(404);
      await sa.patch(`/api/platform/seats/requests/${id}`).send({ status: 'maybe' }).expect(400);
      await adminA.get('/api/platform/seats/requests').expect(403);
    });

    it('refuses an approval below the seats in use when asked, and can decline instead', async () => {
      await newPerson(S.adminAgent, S); // used = 2
      const created = await S.adminAgent.post('/api/admin/seats/requests').send({ requested_seats: 20 }).expect(201);
      const id = created.body.request.id;
      await sa.patch(`/api/platform/seats/requests/${id}`).send({ status: 'approved', approved_seats: 1 }).expect(422);
      const dec = await sa.patch(`/api/platform/seats/requests/${id}`).send({ status: 'declined', response_note: 'Not this quarter' }).expect(200);
      expect(dec.body.request.status).toBe('declined');
      const [org] = await dbQuery('SELECT seat_limit FROM organizations WHERE id = $1', [S.id]);
      expect(org.seat_limit).toBe(4);
      const learnerSeat = await learner.post('/api/admin/seats/requests').send({ requested_seats: 50 });
      expect(learnerSeat.status).toBe(403);
    });

    it('a manager (learner portal) cannot ask for seats', async () => {
      const r = await managerA.post('/api/admin/seats/requests').send({ requested_seats: 99 });
      expect(r.status).toBe(403);
      ok(await adminA.get('/api/admin/seats'));
    });
  });
});
