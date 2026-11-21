/**
 * Organizations (CONTEXT.md §2 and §14): Provisioning, the tenant's own
 * settings, the platform directory / access list / analytics, Organization
 * access (suspension: people keep signing in, email stops) and Offboarding
 * scheduling. Suspension and settings writes use throwaway organizations.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, newPerson, signIn, uniq, type Agent } from './helpers';
import { outboxCount, provisionOrg, type ThrowawayOrg } from './support/1';

const DAY = 86_400_000;

describe('organizations', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let sa: Agent;
  let adminA: Agent;
  let learnerA: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    sa = await signIn(app, fx.platform.admin);
    adminA = await signIn(app, fx.A.admin);
    learnerA = await signIn(app, fx.A.learner);
  });
  afterAll(async () => { await app.close(); });

  describe('provisioning', () => {
    it('creates the org, its three system roles, its first admin (welcomed), the feedback templates and job levels in one step', async () => {
      const slug = uniq('prov').toLowerCase();
      const email = `owner@${slug}.e2e.test`;
      const res = await sa.post('/api/platform/organizations').send({
        name: 'Provisioned Co', slug, industry: 'Technology', seatLimit: 7, plan: 'growth',
        admin: { firstName: 'Olive', lastName: 'Owner', email },
      });
      expect(res.status).toBeLessThan(300);
      expect(res.body.organization).toEqual(expect.objectContaining({ name: 'Provisioned Co', slug, isActive: true, isPlatform: false }));
      const id = res.body.organization.id;
      const roles = await dbQuery('SELECT key, portal, is_system FROM roles WHERE organization_id = $1 ORDER BY key', [id]);
      expect(roles.map((r) => r.key)).toEqual(['admin', 'learner', 'manager']);
      const [owner] = await dbQuery('SELECT role, organization_id FROM users WHERE email = $1', [email]);
      expect(owner).toEqual({ role: 'admin', organization_id: id });
      const [org] = await dbQuery('SELECT seat_limit, industry FROM organizations WHERE id = $1', [id]);
      expect(org).toEqual({ seat_limit: 7, industry: 'Technology' });
      expect((await dbQuery('SELECT id FROM feedback_templates WHERE organization_id = $1', [id])).length).toBe(3);
      expect((await dbQuery('SELECT id FROM organization_job_levels WHERE organization_id = $1', [id])).length).toBeGreaterThan(0);
      const [welcome] = await dbQuery("SELECT link FROM email_outbox WHERE to_email = $1 AND type = 'welcome'", [email]);
      expect(welcome.link).toMatch(/token=/);
    });

    it('refuses a taken identifier, a taken admin address, a bad identifier and a missing admin; tenants cannot provision', async () => {
      const admin = { firstName: 'A', lastName: 'B', email: `${uniq('x')}@x.test` };
      await sa.post('/api/platform/organizations').send({ name: 'Dup', slug: fx.A.slug, admin }).expect(409);
      await sa.post('/api/platform/organizations').send({ name: 'Dup', slug: uniq('d').toLowerCase(), admin: { ...admin, email: fx.A.learner.email } }).expect(409);
      await sa.post('/api/platform/organizations').send({ name: 'Bad', slug: 'Not A Slug!', admin }).expect(400);
      await sa.post('/api/platform/organizations').send({ name: 'NoAdmin', slug: uniq('n').toLowerCase() }).expect(400);
      await adminA.post('/api/platform/organizations').send({ name: 'Mine', slug: uniq('m').toLowerCase(), admin }).expect(403);
    });
  });

  describe('platform reads', () => {
    it('GET /platform/organizations lists every org with its counts and public id', async () => {
      const res = await sa.get('/api/platform/organizations').expect(200);
      const a = res.body.organizations.find((o: { id: number }) => o.id === fx.A.id);
      expect(a).toEqual(expect.objectContaining({ slug: fx.A.slug, publicId: fx.A.publicId, isActive: true, learners: expect.any(Number) }));
      expect(res.body.organizations.some((o: { isPlatform: boolean }) => o.isPlatform)).toBe(true);
      await adminA.get('/api/platform/organizations').expect(403);
      await learnerA.get('/api/platform/organizations').expect(403);
    });

    it('GET /platform/organizations/:id answers by public id or integer, with stats; unknown is 404', async () => {
      const byPub = await sa.get(`/api/platform/organizations/${fx.B.publicId}`).expect(200);
      const byInt = await sa.get(`/api/platform/organizations/${fx.B.id}`).expect(200);
      expect(byPub.body.organization.id).toBe(fx.B.id);
      expect(byInt.body.organization.slug).toBe(fx.B.slug);
      expect(byPub.body.stats).toEqual(expect.objectContaining({ learners: expect.any(Number), admins: expect.any(Number) }));
      await sa.get('/api/platform/organizations/00000000-0000-0000-0000-000000000000').expect(404);
      await adminA.get(`/api/platform/organizations/${fx.A.publicId}`).expect(403);
    });

    it('GET /platform/organizations/tenants names a real owner admin per tenant and leaves out the platform org', async () => {
      const res = await sa.get('/api/platform/organizations/tenants').expect(200);
      const a = res.body.tenants.find((t: { id: number }) => t.id === fx.A.id);
      // Other spec files add limited admins to org A in a full run, so the count is a floor.
      expect(a).toEqual(expect.objectContaining({ admin_email: fx.A.admin.email, admin_is_owner: true, is_active: true }));
      expect(a.admin_portal_count).toBeGreaterThanOrEqual(1);
      expect(res.body.tenants.map((t: { id: number }) => t.id)).not.toContain(fx.platform.id);
      expect(res.body.counts.total).toBe(res.body.tenants.length);
      await adminA.get('/api/platform/organizations/tenants').expect(403);
    });

    it('GET /platform/organizations/access lists every privileged account with its access level', async () => {
      const res = await sa.get('/api/platform/organizations/access').expect(200);
      const a = res.body.accounts.find((x: { id: number }) => x.id === fx.A.admin.id);
      expect(a).toEqual(expect.objectContaining({ organization_id: fx.A.id, level: 'owner', status: 'active' }));
      const ids = res.body.accounts.map((x: { id: number }) => x.id);
      expect(ids).not.toContain(fx.A.learner.id);
      expect(ids).toContain(fx.platform.admin.id);
      expect(res.body.counts.platform).toBeGreaterThanOrEqual(1);
      await adminA.get('/api/platform/organizations/access').expect(403);
    });

    it('GET /platform/analytics totals every organization', async () => {
      const res = await sa.get('/api/platform/analytics').expect(200);
      expect(res.body.totals.organizations).toBe(res.body.byOrganization.length);
      expect(res.body.byOrganization.map((o: { organizationId: number }) => o.organizationId)).toEqual(expect.arrayContaining([fx.A.id, fx.B.id]));
      await adminA.get('/api/platform/analytics').expect(403);
      await learnerA.get('/api/platform/analytics').expect(403);
    });
  });

  describe("a tenant's own settings", () => {
    let O: ThrowawayOrg;
    beforeAll(async () => { O = await provisionOrg(app, sa); });

    it('GET /admin/organization shows the org with its commercial terms read-only', async () => {
      const res = await adminA.get('/api/admin/organization').expect(200);
      expect(res.body.organization).toEqual(expect.objectContaining({ id: fx.A.id, slug: fx.A.slug, seat_limit: 5000, community_enabled: true }));
      await learnerA.get('/api/admin/organization').expect(403);
    });

    it('PATCH /admin/organization writes the tenant fields and silently ignores the commercial ones', async () => {
      const slug = uniq('ren').toLowerCase();
      const res = await O.adminAgent.patch('/api/admin/organization').send({
        name: 'Renamed Ltd', slug, industry: 'Retail', certificate_prefix: 'ren', community_enabled: false,
        leaderboard_name_display: 'full', plan: 'enterprise', seatLimit: 9999, seat_limit: 9999, isActive: false,
      }).expect(200);
      expect(res.body.organization).toEqual(expect.objectContaining({ name: 'Renamed Ltd', slug, industry: 'Retail', certificate_prefix: 'REN', community_enabled: false, leaderboard_name_display: 'full', seat_limit: 50 }));
      const [row] = await dbQuery('SELECT name, slug, seat_limit, is_active, plan FROM organizations WHERE id = $1', [O.id]);
      expect(row).toEqual({ name: 'Renamed Ltd', slug, seat_limit: 50, is_active: 1, plan: null });
      // Re-saving its own slug is not a conflict; another org's is.
      await O.adminAgent.patch('/api/admin/organization').send({ slug }).expect(200);
      await O.adminAgent.patch('/api/admin/organization').send({ slug: fx.A.slug }).expect(409);
      await O.adminAgent.patch('/api/admin/organization').send({ slug: 'Bad Slug' }).expect(400);
      await O.adminAgent.patch('/api/admin/organization').send({ leaderboard_name_display: 'nickname' }).expect(400);
      // An empty patch is a read, not a 500.
      await O.adminAgent.patch('/api/admin/organization').send({}).expect(200);
      await learnerA.patch('/api/admin/organization').send({ name: 'x' }).expect(403);
      const [a] = await dbQuery('SELECT name FROM organizations WHERE id = $1', [fx.A.id]);
      expect(a.name).toBe('Org A E2E');
    });

    it('PATCH /platform/organizations/:id sets contract fields, omitted fields untouched', async () => {
      const end = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
      const res = await sa.patch(`/api/platform/organizations/${O.publicId}`).send({ contractEnd: end, contractValue: 1234.5, plan: 'growth', notes: 'Signed' }).expect(200);
      expect(res.body.organization.id).toBe(O.id);
      await sa.patch(`/api/platform/organizations/${O.id}`).send({ notes: 'Renewal call' }).expect(200);
      const [row] = await dbQuery('SELECT contract_value, plan, notes, name FROM organizations WHERE id = $1', [O.id]);
      expect({ ...row, contract_value: Number(row.contract_value) }).toEqual({ contract_value: 1234.5, plan: 'growth', notes: 'Renewal call', name: 'Renamed Ltd' });
      const t = (await sa.get('/api/platform/organizations/tenants').expect(200)).body.tenants.find((x: { id: number }) => x.id === O.id);
      expect(t.contract_state).toBe('expiring');
      await sa.patch(`/api/platform/organizations/${O.id}`).send({ plan: 'bogus' }).expect(400);
      await sa.patch('/api/platform/organizations/99999999').send({ notes: 'x' }).expect(404);
      await O.adminAgent.patch(`/api/platform/organizations/${O.id}`).send({ plan: 'enterprise' }).expect(403);
    });
  });

  describe('organization access (suspension) and offboarding', () => {
    let Z: ThrowawayOrg;
    let learnerEmail: string;
    let learnerPw: string;

    beforeAll(async () => {
      Z = await provisionOrg(app, sa);
      const p = await newPerson(Z.adminAgent, Z);
      learnerEmail = p.email;
      learnerPw = p.password;
    });
    afterAll(async () => {
      // Leave it active, so nothing else is surprised by a suspended org.
      await sa.patch(`/api/platform/organizations/${Z.id}`).send({ isActive: true });
    });

    it('offboarding cannot be scheduled while access is on', async () => {
      const state = await sa.get(`/api/platform/organizations/${Z.publicId}/data-deletion`).expect(200);
      expect(state.body.deletion).toEqual({ access_enabled: true, due_at: null, deleted_at: null, state: 'none' });
      const r = await sa.put(`/api/platform/organizations/${Z.publicId}/data-deletion`).send({ due_at: new Date(Date.now() + 3 * DAY).toISOString() });
      expect(r.status).toBe(422);
      expect(r.body.message).toMatch(/Switch off/);
    });

    it('switching access off deletes nothing: people still sign in and use the API, but no new email is queued for the org', async () => {
      const off = await sa.patch(`/api/platform/organizations/${Z.publicId}`).send({ isActive: false }).expect(200);
      expect(off.body.organization.isActive).toBe(false);
      const [row] = await dbQuery('SELECT is_active FROM organizations WHERE id = $1', [Z.id]);
      expect(row.is_active).toBe(0);
      const t = (await sa.get('/api/platform/organizations/tenants').expect(200)).body;
      expect(t.tenants.find((x: { id: number }) => x.id === Z.id).is_active).toBe(false);
      expect(t.counts.suspended).toBeGreaterThanOrEqual(1);

      // The open session keeps working, and fresh sign-ins work too.
      await Z.adminAgent.get('/api/admin/users').expect(200);
      const learner = await signIn(app, { email: learnerEmail, password: learnerPw });
      await learner.get('/api/auth/me').expect(200);
      await learner.get('/api/learner/courses').expect(200);
      const admin = await signIn(app, Z.admin);
      await admin.get('/api/admin/organization').expect(200);

      const before = await outboxCount(Z.id);
      // A welcome (new person) and a password reset are both email: neither is queued.
      const email = `${uniq('susp')}@${Z.slug}.e2e.test`;
      await admin.post('/api/admin/users').send({ first_name: 'Sus', last_name: 'Pended', email }).expect(201);
      const forgot = await anon(app).post('/api/auth/forgot-password').send({ email: learnerEmail });
      expect(forgot.status).toBeLessThan(300);
      await new Promise((r) => setTimeout(r, 300));
      expect(await outboxCount(Z.id)).toBe(before);
      expect(await dbQuery('SELECT id FROM email_outbox WHERE to_email = ANY($1)', [[email]])).toHaveLength(0);
    });

    it('once off, offboarding must be at least a day ahead, is shown as scheduled, and can be cancelled', async () => {
      await sa.put(`/api/platform/organizations/${Z.publicId}/data-deletion`).send({ due_at: new Date(Date.now() + 3600_000).toISOString() }).expect(422);
      await sa.put(`/api/platform/organizations/${Z.publicId}/data-deletion`).send({ due_at: 'soon' }).expect(400);
      const due = new Date(Date.now() + 2 * DAY).toISOString();
      const res = await sa.put(`/api/platform/organizations/${Z.publicId}/data-deletion`).send({ due_at: due }).expect(200);
      expect(res.body.deletion).toEqual(expect.objectContaining({ access_enabled: false, state: 'scheduled', deleted_at: null }));
      const [row] = await dbQuery('SELECT data_deletion_due_at FROM organizations WHERE id = $1', [Z.id]);
      expect(Math.abs(new Date(row.data_deletion_due_at).getTime() - Date.parse(due))).toBeLessThan(1000);
      expect((await sa.get(`/api/platform/organizations/${Z.id}/data-deletion`).expect(200)).body.deletion.state).toBe('scheduled');

      const cancel = await sa.delete(`/api/platform/organizations/${Z.publicId}/data-deletion`).expect(200);
      expect(cancel.body.deletion).toEqual(expect.objectContaining({ state: 'none', due_at: null }));

      // Never the platform org, and never by a tenant.
      await sa.put(`/api/platform/organizations/${fx.platform.id}/data-deletion`).send({ due_at: due }).expect(404);
      await sa.get(`/api/platform/organizations/${fx.platform.id}/data-deletion`).expect(404);
      await adminA.put(`/api/platform/organizations/${Z.publicId}/data-deletion`).send({ due_at: due }).expect(403);
      await adminA.delete(`/api/platform/organizations/${Z.publicId}/data-deletion`).expect(403);
      await adminA.get(`/api/platform/organizations/${Z.publicId}/data-deletion`).expect(403);
    });

    it('switching access back on lets email flow again and offboarding is refused again', async () => {
      await sa.patch(`/api/platform/organizations/${Z.publicId}`).send({ isActive: true }).expect(200);
      const before = await outboxCount(Z.id);
      const admin = await signIn(app, Z.admin);
      const email = `${uniq('back')}@${Z.slug}.e2e.test`;
      await admin.post('/api/admin/users').send({ first_name: 'Back', last_name: 'On', email }).expect(201);
      for (let i = 0; i < 20 && (await outboxCount(Z.id)) === before; i++) await new Promise((r) => setTimeout(r, 50));
      expect(await outboxCount(Z.id)).toBeGreaterThan(before);
      await sa.put(`/api/platform/organizations/${Z.publicId}/data-deletion`).send({ due_at: new Date(Date.now() + 3 * DAY).toISOString() }).expect(422);
    });
  });
});
