/**
 * Roles and permissions (CONTEXT.md §3): the catalogue, custom Roles, the
 * Permission guard, the Permission version sign-out, Change role, the Lockout
 * rules, and Delegated administration from the platform portal.
 *
 * Every Role write signs its whole Organization out, so the writes happen in a
 * throwaway Organization, never in the shared orgs A and B.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, lastOutbox, newPerson, signIn, uniq, type Agent, type Person } from './helpers';
import { enrolSignIn, provisionOrg, type ThrowawayOrg } from './support/1';

const permVersion = async (orgId: number) => Number((await dbQuery('SELECT perm_version FROM organizations WHERE id = $1', [orgId]))[0].perm_version);
const userPermVersion = async (id: number) => Number((await dbQuery('SELECT perm_version FROM users WHERE id = $1', [id]))[0].perm_version);

describe('roles and permissions', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let sa: Agent;
  let adminA: Agent;
  let learnerA: Agent;
  let R: ThrowawayOrg;
  let admin: Agent;

  const refreshRoles = async () => {
    const rows = await dbQuery<{ id: number; key: string }>('SELECT id, key FROM roles WHERE organization_id = $1', [R.id]);
    R.roles = Object.fromEntries(rows.map((r) => [r.key, r.id]));
  };
  /** A Role write bumped the org's version: the admin signs in again. */
  const resign = async () => { admin = await signIn(app, R.admin); };

  beforeAll(async () => {
    app = await createTestApp();
    sa = await signIn(app, fx.platform.admin);
    adminA = await signIn(app, fx.A.admin);
    learnerA = await signIn(app, fx.A.learner);
    R = await provisionOrg(app, sa);
    admin = R.adminAgent;
  });
  afterAll(async () => { await app.close(); });

  it('GET /admin/permissions is the code catalogue, for any admin; a learner is refused', async () => {
    const res = await adminA.get('/api/admin/permissions').expect(200);
    const ids = res.body.permissions.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['manage_roles', 'view_employees', 'manage_users', 'manage_organization']));
    expect(res.body.permissions[0]).toEqual(expect.objectContaining({ id: expect.any(String), label: expect.any(String) }));
    await learnerA.get('/api/admin/permissions').expect(403);
  });

  it('GET /admin/roles lists this organization roles with holders; nothing from another org', async () => {
    const res = await adminA.get('/api/admin/roles').expect(200);
    const byKey = Object.fromEntries(res.body.roles.map((r: { key: string }) => [r.key, r]));
    expect(byKey.admin).toEqual(expect.objectContaining({ portal: 'admin', isSystem: true, id: fx.A.roles.admin }));
    expect(byKey.manager.permissions).toEqual(expect.arrayContaining(['view_team_learning']));
    expect(byKey.learner.users).toBeGreaterThanOrEqual(2);
    expect(res.body.roles.map((r: { id: number }) => r.id)).not.toContain(fx.B.roles.admin);
    await learnerA.get('/api/admin/roles').expect(403);
  });

  it('POST /admin/roles/trainer creates the Trainer role once and signs nobody out', async () => {
    const before = await permVersion(R.id);
    const res = await admin.post('/api/admin/roles/trainer').expect(200);
    const trainer = res.body.roles.find((r: { key: string }) => r.key === 'trainer');
    expect(trainer).toEqual(expect.objectContaining({ portal: 'trainer', isSystem: true }));
    expect(trainer.permissions).toEqual(expect.arrayContaining(['view_own_sessions', 'mark_attendance']));
    const again = await admin.post('/api/admin/roles/trainer').expect(200);
    expect(again.body.roles.filter((r: { key: string }) => r.key === 'trainer')).toHaveLength(1);
    expect(await permVersion(R.id)).toBe(before);
    await admin.get('/api/auth/me').expect(200);
    await learnerA.post('/api/admin/roles/trainer').expect(403);
  });

  describe('custom roles and the permission guard', () => {
    let auditor: Person;
    let auditorRoleId: number;

    it('creates a custom role, which signs the organization out; refuses a duplicate key and an unknown permission', async () => {
      const before = await permVersion(R.id);
      const res = await admin.post('/api/admin/roles').send({ key: 'People Viewer', label: 'People viewer', portal: 'admin', scope: 'org', permissions: ['view_employees'] }).expect(201);
      const role = res.body.roles.find((r: { key: string }) => r.key === 'people_viewer');
      expect(role).toEqual(expect.objectContaining({ label: 'People viewer', portal: 'admin', isSystem: false, permissions: ['view_employees'] }));
      auditorRoleId = role.id;
      expect(res.body.permVersion).toBe(before + 1);
      expect(await permVersion(R.id)).toBe(before + 1);
      // The admin's own token is now stale.
      await admin.get('/api/admin/roles').expect(401);
      await resign();

      await admin.post('/api/admin/roles').send({ key: 'people_viewer', label: 'Dup', portal: 'admin' }).expect(409);
      await admin.post('/api/admin/roles').send({ key: 'x', label: 'X', portal: 'admin', permissions: ['fly_planes'] }).expect(422);
      await admin.post('/api/admin/roles').send({ key: 'x', label: 'X', portal: 'moon' }).expect(400);
      await learnerA.post('/api/admin/roles').send({ key: 'x', label: 'X', portal: 'admin' }).expect(403);
    });

    it('a person on that role may read people but every write needs its own permission (403)', async () => {
      await refreshRoles();
      auditor = await newPerson(admin, R, 'people_viewer');
      const [row] = await dbQuery('SELECT role, role_id FROM users WHERE id = $1', [auditor.id]);
      expect(row).toEqual({ role: 'admin', role_id: auditorRoleId });
      const ag = await enrolSignIn(app, auditor);
      await ag.get('/api/admin/users').expect(200);
      await ag.get('/api/admin/users/directory').expect(200);
      await ag.post('/api/admin/users').send({ first_name: 'N', last_name: 'O', email: `${uniq('n')}@x.test` }).expect(403);
      await ag.post('/api/admin/roles').send({ key: 'k', label: 'K', portal: 'admin' }).expect(403);
      await ag.patch('/api/admin/organization').send({ name: 'nope' }).expect(403);
      await ag.get('/api/admin/permissions').expect(200);
    });

    it('PATCH /admin/roles/:id renames and re-grants (signing the org out); you cannot disarm your own role', async () => {
      const res = await admin.patch(`/api/admin/roles/${auditorRoleId}`).send({ label: 'Auditor', permissions: ['view_employees', 'view_reports'] }).expect(200);
      const role = res.body.roles.find((r: { id: number }) => r.id === auditorRoleId);
      expect(role).toEqual(expect.objectContaining({ label: 'Auditor', permissions: expect.arrayContaining(['view_employees', 'view_reports']) }));
      const grants = await dbQuery('SELECT permission FROM role_permissions WHERE role_id = $1 ORDER BY permission', [auditorRoleId]);
      expect(grants.map((g) => g.permission)).toEqual(['view_employees', 'view_reports']);
      await resign();

      const own = await admin.patch(`/api/admin/roles/${R.roles.admin}`).send({ permissions: ['view_employees'] });
      expect(own.status).toBe(422);
      expect(own.body.message).toMatch(/your own role/);
      await admin.patch(`/api/admin/roles/${fx.A.roles.admin}`).send({ label: 'Hijack' }).expect(404);
      await admin.patch('/api/admin/roles/99999999').send({ label: 'x' }).expect(404);
      await learnerA.patch(`/api/admin/roles/${auditorRoleId}`).send({ label: 'x' }).expect(403);
    });

    it('PATCH /admin/users/:id/role moves one person and signs out only them; same role is a no-op', async () => {
      const orgBefore = await permVersion(R.id);
      const userBefore = await userPermVersion(auditor.id);
      const res = await admin.patch(`/api/admin/users/${auditor.id}/role`).send({ roleId: R.roles.learner }).expect(200);
      expect(res.body).toEqual({ ok: true, role: expect.objectContaining({ key: 'learner', portal: 'learner' }) });
      const [row] = await dbQuery('SELECT role, role_id FROM users WHERE id = $1', [auditor.id]);
      expect(row).toEqual({ role: 'learner', role_id: R.roles.learner });
      expect(await userPermVersion(auditor.id)).toBe(userBefore + 1);
      expect(await permVersion(R.id)).toBe(orgBefore);
      await admin.get('/api/auth/me').expect(200);

      const same = await admin.patch(`/api/admin/users/${auditor.id}/role`).send({ roleId: R.roles.learner }).expect(200);
      expect(same.body.unchanged).toBe(true);
      expect(await userPermVersion(auditor.id)).toBe(userBefore + 1);

      // A role id or a user id from another organization looks like nothing.
      await admin.patch(`/api/admin/users/${auditor.id}/role`).send({ roleId: fx.A.roles.manager }).expect(404);
      await admin.patch(`/api/admin/users/${fx.A.learner.id}/role`).send({ roleId: R.roles.learner }).expect(404);
      await learnerA.patch(`/api/admin/users/${fx.A.learner2.id}/role`).send({ roleId: fx.A.roles.manager }).expect(403);
    });

    it('Lockout and seat rules: the last admin cannot leave the admin portal; a move onto a learner role respects the seat limit', async () => {
      const last = await admin.patch(`/api/admin/users/${R.admin.id}/role`).send({ roleId: R.roles.learner });
      expect(last.status).toBe(409);
      expect(last.body.message).toMatch(/only active admin/);

      const trainer = await newPerson(admin, R, 'trainer');
      const [{ used }] = await dbQuery("SELECT COUNT(*)::int AS used FROM users WHERE organization_id = $1 AND role = 'learner' AND is_active = 1", [R.id]);
      await sa.put(`/api/platform/seats/organizations/${R.id}`).send({ seat_limit: used }).expect(200);
      const full = await admin.patch(`/api/admin/users/${trainer.id}/role`).send({ roleId: R.roles.learner });
      expect(full.status).toBe(409);
      expect(full.body.message).toMatch(/seats are in use/);
      await sa.put(`/api/platform/seats/organizations/${R.id}`).send({ seat_limit: used + 1 }).expect(200);
      await admin.patch(`/api/admin/users/${trainer.id}/role`).send({ roleId: R.roles.learner }).expect(200);
    });

    it('DELETE /admin/roles/:id refuses a held role and a system role, and deletes an unheld custom one', async () => {
      const held = await admin.delete(`/api/admin/roles/${R.roles.learner}`);
      expect(held.status).toBe(422);
      expect(held.body.message).toMatch(/held by/);
      await admin.delete(`/api/admin/roles/${R.roles.trainer}`).expect(422);
      await learnerA.delete(`/api/admin/roles/${auditorRoleId}`).expect(403);
      await adminA.delete(`/api/admin/roles/${auditorRoleId}`).expect(404);
      const res = await admin.delete(`/api/admin/roles/${auditorRoleId}`).expect(200);
      expect(res.body.roles.map((r: { id: number }) => r.id)).not.toContain(auditorRoleId);
      expect(await dbQuery('SELECT id FROM roles WHERE id = $1', [auditorRoleId])).toHaveLength(0);
      await resign();
    });
  });

  describe('extra admin permissions on a learner-portal role (§10.65)', () => {
    let coordinatorRoleId: number;
    let coordinator: Person;
    let co: Agent;
    let plain: Agent;

    it('the catalogue says which portal each permission works on', async () => {
      const res = await admin.get('/api/admin/permissions').expect(200);
      const byId = Object.fromEntries(res.body.permissions.map((p: { id: string; portals: string[] }) => [p.id, p.portals]));
      expect(byId.manage_courses).toEqual(['admin']);
      expect(byId.view_team_learning).toEqual(['learner']);
      expect(byId.mark_attendance).toEqual(['admin', 'trainer']);
    });

    it('a learner-portal role given admin permissions keeps its portal and gains exactly those admin routes', async () => {
      await sa.put(`/api/platform/seats/organizations/${R.id}`).send({ seat_limit: 1000 }).expect(200);
      const res = await admin.post('/api/admin/roles').send({ key: 'coordinator', label: 'Coordinator', portal: 'learner', scope: 'self', permissions: ['assign_learning', 'manage_users'] }).expect(201);
      coordinatorRoleId = res.body.roles.find((r: { key: string }) => r.key === 'coordinator').id;
      await resign();
      await refreshRoles();
      coordinator = await newPerson(admin, R, 'coordinator');
      co = await enrolSignIn(app, coordinator);
      plain = await enrolSignIn(app, await newPerson(admin, R, 'learner'));

      // Still a learner: their own portal works.
      await co.get('/api/learner/dashboard').expect(200);
      // An admin route naming a permission they hold: open.
      await co.get('/api/admin/courses').expect(200);
      await co.get('/api/admin/journeys').expect(200);
      // An admin read open to every admin role, but none of their permissions needs it.
      await co.get('/api/admin/sessions').expect(403);
      // A permission they were not given.
      await co.get('/api/admin/users').expect(403);
      await co.get('/api/admin/dashboard').expect(403);
      // An admin route that names no permission stays the admin portal's.
      await co.get('/api/admin/roles').expect(200); // ROLE_READERS includes manage_users
      await co.get('/api/admin/permissions').expect(403);

      // A plain learner, holding nothing extra, is refused all of it.
      await plain.get('/api/admin/courses').expect(403);
      await plain.get('/api/admin/organization').expect(403);
      // An admin-portal role keeps open content reads it had before.
      await admin.get('/api/admin/sessions').expect(200);
    });

    it('an extra manage_users cannot mint an admin or change its own role', async () => {
      const toAdmin = await co.post('/api/admin/users').send({ first_name: 'N', last_name: 'O', email: `${uniq('n')}@${R.slug}.e2e.test`, role_id: R.roles.admin });
      expect(toAdmin.status).toBe(403);
      expect(toAdmin.body.message).toMatch(/Only an admin/);
      await co.post('/api/admin/users').send({ first_name: 'N', last_name: 'O', email: `${uniq('n')}@${R.slug}.e2e.test` }).expect(201);

      const self = await co.patch(`/api/admin/users/${coordinator.id}/role`).send({ roleId: R.roles.learner });
      expect(self.status).toBe(403);
      const promote = await co.patch(`/api/admin/users/${coordinator.id}/role`).send({ roleId: R.roles.admin });
      expect(promote.status).toBe(403);
      expect((await dbQuery('SELECT role_id FROM users WHERE id = $1', [coordinator.id]))[0].role_id).toBe(coordinatorRoleId);
    });

    it('learner-portal routes do not open to an admin role in the other direction', async () => {
      await admin.get('/api/learner/dashboard').expect(403);
    });
  });

  describe('delegated administration (platform)', () => {
    let customId: number;

    it('lists an organization roles by public id or integer id; tenants are refused', async () => {
      const byPublic = await sa.get(`/api/platform/organizations/${R.publicId}/roles`).expect(200);
      const byInt = await sa.get(`/api/platform/organizations/${R.id}/roles`).expect(200);
      expect(byPublic.body.roles.map((r: { id: number }) => r.id).sort()).toEqual(byInt.body.roles.map((r: { id: number }) => r.id).sort());
      expect(byPublic.body.roles.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['admin', 'learner', 'manager']));
      await sa.get('/api/platform/organizations/00000000-0000-0000-0000-000000000000/roles').expect(404);
      await admin.get(`/api/platform/organizations/${R.publicId}/roles`).expect(403);
    });

    it('creates, edits and deletes a role in that org: the org is signed out, the platform admin is not', async () => {
      const before = await permVersion(R.id);
      const created = await sa.post(`/api/platform/organizations/${R.publicId}/roles`).send({ key: 'content_lead', label: 'Content lead', portal: 'admin', permissions: ['manage_courses'] }).expect(201);
      customId = created.body.roles.find((r: { key: string }) => r.key === 'content_lead').id;
      const [row] = await dbQuery('SELECT organization_id FROM roles WHERE id = $1', [customId]);
      expect(row.organization_id).toBe(R.id);
      expect(await permVersion(R.id)).toBe(before + 1);
      await admin.get('/api/admin/roles').expect(401);
      await sa.get('/api/platform/organizations').expect(200);

      const patched = await sa.patch(`/api/platform/organizations/${R.publicId}/roles/${customId}`).send({ label: 'Content owner' }).expect(200);
      expect(patched.body.roles.find((r: { id: number }) => r.id === customId).label).toBe('Content owner');
      // The lockout rules apply to the platform too.
      await sa.patch(`/api/platform/organizations/${R.publicId}/roles/${R.roles.admin}`).send({ permissions: ['view_employees'] }).expect(422);
      // A role from another org through this org's path is not found.
      await sa.patch(`/api/platform/organizations/${R.publicId}/roles/${fx.A.roles.admin}`).send({ label: 'x' }).expect(404);
      await admin.patch(`/api/platform/organizations/${R.publicId}/roles/${customId}`).send({ label: 'x' }).expect(401);

      await sa.delete(`/api/platform/organizations/${R.publicId}/roles/${customId}`).expect(200);
      expect(await dbQuery('SELECT id FROM roles WHERE id = $1', [customId])).toHaveLength(0);
      await resign();
      await admin.delete(`/api/platform/organizations/${R.publicId}/roles/${R.roles.manager}`).expect(403);
      await admin.post(`/api/platform/organizations/${R.publicId}/roles`).send({ key: 'k', label: 'K', portal: 'admin' }).expect(403);
    });

    it('creates a person on a chosen role, with no password set by anyone and a welcome link', async () => {
      const email = `${uniq('deleg')}@${R.slug}.e2e.test`;
      const res = await sa.post(`/api/platform/organizations/${R.publicId}/users`).send({ firstName: 'Del', lastName: 'Egated', email, roleId: R.roles.manager, department: 'Ops', password: 'Typed-Passw0rd!' }).expect(201);
      expect(res.body.user).toEqual(expect.objectContaining({ email, role: 'learner', roleId: R.roles.manager, isActive: true }));
      const [row] = await dbQuery('SELECT organization_id, role_id, department FROM users WHERE email = $1', [email]);
      expect(row).toEqual({ organization_id: R.id, role_id: R.roles.manager, department: 'Ops' });
      // A typed password is stripped: it does not work.
      await expect(signIn(app, { email, password: 'Typed-Passw0rd!' })).rejects.toThrow(/login failed/);
      expect(await lastOutbox(email, 'welcome')).toBeDefined();

      await sa.post(`/api/platform/organizations/${R.publicId}/users`).send({ firstName: 'D', lastName: 'E', email, roleId: R.roles.manager }).expect(409);
      await sa.post(`/api/platform/organizations/${R.publicId}/users`).send({ firstName: 'D', lastName: 'E', email: `${uniq('d')}@x.test`, roleId: fx.A.roles.learner }).expect(404);
      await admin.post(`/api/platform/organizations/${R.publicId}/users`).send({ firstName: 'D', lastName: 'E', email: `${uniq('d')}@x.test`, roleId: R.roles.learner }).expect(403);
    });
  });
});
