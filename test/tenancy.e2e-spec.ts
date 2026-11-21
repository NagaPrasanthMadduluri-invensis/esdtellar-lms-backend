/**
 * Tenant isolation (CONTEXT.md §2 "Organization", §16; the intent of
 * scripts/test-isolation.mjs): content and activity created in org A is probed
 * from org B.
 *   1. cross-org reads and writes are 404, never 403, never data;
 *   2. lists never contain another org's rows;
 *   3. a learner sees only their own org;
 *   4. ids in request bodies cannot cross tenants;
 *   5. platform routes refuse tenant admins and learners;
 *   6. writes land in the caller's org;
 *   7. the learning community is org-scoped;
 *   8. private uploads are not served at /uploads (only course-thumbnails and avatars are).
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, signIn, uniq, type Agent } from './helpers';

describe('tenancy', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let sa: Agent;
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let learnerB: Agent;

  // Org A content, created through the API.
  let courseA: number;
  let moduleA: number;
  let assessmentA: number;
  let sessionA: number;
  let certA: number;
  let postA: string;
  // Org B content, for the reverse direction.
  let courseB: number;

  beforeAll(async () => {
    app = await createTestApp();
    sa = await signIn(app, fx.platform.admin);
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    learnerB = await signIn(app, fx.B.learner);

    const c = await adminA.post('/api/admin/courses').send({ name: uniq('Tenancy course A') }).expect(201);
    courseA = c.body.course.id;
    const m = await adminA.post(`/api/admin/courses/${courseA}/modules`).send({ title: 'Module A' }).expect(201);
    moduleA = m.body.module.id;
    const a = await adminA.post(`/api/admin/courses/${courseA}/assessments`).send({ title: 'Assessment A' }).expect(201);
    assessmentA = a.body.assessment.id;
    const s = await adminA.post('/api/admin/sessions').send({
      title: uniq('Tenancy session A'), trainer: 'Trainer Tester', trainer_user_id: fx.A.trainer.id,
      venue_url: 'Room 1', date: new Date().toISOString().slice(0, 10), start_time: '10:00', end_time: '11:00',
    }).expect(201);
    sessionA = s.body.session.id;
    const cert = await adminA.post('/api/admin/certificates').send({ userId: fx.A.learner.id, courseId: courseA }).expect(201);
    certA = cert.body.certificate.id;
    const post = await learnerA.post('/api/learner/community').send({ type: 'question', title: uniq('Tenancy question'), body: 'Only inside org A.', hashtags: ['tenancy'] }).expect(201);
    postA = post.body.post.id;

    const cb = await adminB.post('/api/admin/courses').send({ name: uniq('Tenancy course B') }).expect(201);
    courseB = cb.body.course.id;
  });
  afterAll(async () => { await app.close(); });

  describe('1. cross-org reads and writes are 404, never 403', () => {
    it('org B admin cannot read org A records', async () => {
      const probes: [string, string][] = [
        ['get', `/api/admin/users/${fx.A.learner.id}`],
        ['get', `/api/admin/courses/${courseA}`],
        ['get', `/api/admin/sessions/${sessionA}`],
        ['get', `/api/admin/assessments/${assessmentA}`],
        ['patch', `/api/admin/certificates/${certA}`],
      ];
      for (const [method, path] of probes) {
        const res = await (adminB as unknown as Record<string, (p: string) => Promise<{ status: number; body: unknown }>>)[method](path);
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
      }
      // Control: the owner reads them.
      await adminA.get(`/api/admin/courses/${courseA}`).expect(200);
      await adminA.get(`/api/admin/sessions/${sessionA}`).expect(200);
      await adminA.get(`/api/admin/assessments/${assessmentA}`).expect(200);
      await adminA.get(`/api/admin/users/${fx.A.learner.id}`).expect(200);
    });

    it('org A admin cannot read org B records (reverse direction)', async () => {
      await adminA.get(`/api/admin/courses/${courseB}`).expect(404);
      await adminA.get(`/api/admin/users/${fx.B.learner.id}`).expect(404);
    });

    it('org B admin cannot edit or delete org A records, and they are unchanged', async () => {
      await adminB.put(`/api/admin/courses/${courseA}`).send({ name: 'hijacked' }).expect(404);
      await adminB.put(`/api/admin/users/${fx.A.learner.id}`).send({ first_name: 'H', last_name: 'J', email: 'hj@x.test' }).expect(404);
      await adminB.patch(`/api/admin/users/${fx.A.learner.id}`).send({ is_active: false }).expect(404);
      await adminB.delete(`/api/admin/users/${fx.A.learner.id}`).expect(404);
      await adminB.put(`/api/admin/sessions/${sessionA}`).send({ title: 'hijacked' }).expect((r) => expect([400, 404]).toContain(r.status));
      // DELETE of a foreign course, session or assessment: see the 404 test below. Whatever
      // the status, it must never be 403 and must delete nothing.
      for (const path of [`/api/admin/courses/${courseA}`, `/api/admin/sessions/${sessionA}`, `/api/admin/assessments/${assessmentA}`]) {
        ok200or404((await adminB.delete(path)).status);
      }
      expect(await dbQuery('SELECT id FROM courses WHERE id = $1', [courseA])).toHaveLength(1);
      expect(await dbQuery('SELECT id FROM sessions WHERE id = $1', [sessionA])).toHaveLength(1);
      expect(await dbQuery('SELECT id FROM assessments WHERE id = $1', [assessmentA])).toHaveLength(1);
      const [course] = await dbQuery('SELECT name FROM courses WHERE id = $1', [courseA]);
      expect(course.name).not.toBe('hijacked');
      const [u] = await dbQuery('SELECT is_active, first_name FROM users WHERE id = $1', [fx.A.learner.id]);
      expect(u).toEqual({ is_active: 1, first_name: 'Learner' });
    });
  });

  it('DELETE of another org course, session or assessment answers 404 and deletes nothing', async () => {
    await adminB.delete(`/api/admin/courses/${courseA}`).expect(404);
    await adminB.delete(`/api/admin/sessions/${sessionA}`).expect(404);
    await adminB.delete(`/api/admin/assessments/${assessmentA}`).expect(404);
  });

  describe('2. lists never contain another org rows', () => {
    const ids = (rows: { id: number }[] | undefined) => (rows ?? []).map((r) => r.id);

    it('users, employees, directory and people', async () => {
      const ownA = (await dbQuery('SELECT id FROM users WHERE organization_id = $1', [fx.A.id])).map((r) => r.id);
      for (const [path, key] of [['/api/admin/users', 'users'], ['/api/admin/employees', 'employees'], ['/api/admin/users/directory?limit=100', 'users'], ['/api/admin/users/people', 'people']] as const) {
        const a = ids((await adminA.get(path).expect(200)).body[key]);
        const b = ids((await adminB.get(path).expect(200)).body[key]);
        expect(a.length).toBeGreaterThan(0);
        expect(a.every((id) => ownA.includes(id))).toBe(true);
        expect(b.some((id) => ownA.includes(id))).toBe(false);
      }
    });

    it('courses, sessions, assessments and certificates', async () => {
      const coursesB = ids((await adminB.get('/api/admin/courses').expect(200)).body.courses);
      expect(coursesB).toContain(courseB);
      expect(coursesB).not.toContain(courseA);
      expect(ids((await adminA.get('/api/admin/courses').expect(200)).body.courses)).not.toContain(courseB);

      expect(ids((await adminA.get('/api/admin/sessions').expect(200)).body.sessions)).toContain(sessionA);
      expect(ids((await adminB.get('/api/admin/sessions').expect(200)).body.sessions)).not.toContain(sessionA);

      expect(ids((await adminA.get('/api/admin/all-assessments').expect(200)).body.assessments)).toContain(assessmentA);
      expect(ids((await adminB.get('/api/admin/all-assessments').expect(200)).body.assessments)).not.toContain(assessmentA);

      expect(ids((await adminA.get('/api/admin/certificates').expect(200)).body.certificates)).toContain(certA);
      expect(ids((await adminB.get('/api/admin/certificates').expect(200)).body.certificates)).not.toContain(certA);
    });

    it('roles', async () => {
      const rolesB = ids((await adminB.get('/api/admin/roles').expect(200)).body.roles);
      expect(rolesB).not.toContain(fx.A.roles.admin);
      expect(rolesB).toContain(fx.B.roles.admin);
    });
  });

  describe('3. a learner sees only their own organization', () => {
    it('leaderboard and My Courses carry nothing from org A', async () => {
      const lb = await learnerB.get('/api/learner/leaderboard').expect(200);
      const lbIds = ids2(lb.body.allLearners);
      expect(lbIds).toContain(fx.B.learner.id);
      expect(lbIds).not.toContain(fx.A.learner.id);
      expect(lbIds).not.toContain(fx.A.learner2.id);
      const mine = await learnerB.get('/api/learner/courses').expect(200);
      const courseIds = (mine.body.courses ?? []).map((c: { course: { id: number } }) => c.course.id);
      expect(courseIds).not.toContain(courseA);
    });
  });

  describe('4. ids in request bodies cannot cross tenants', () => {
    it('assigning org A learner to an org B course is 404 and writes nothing', async () => {
      await adminB.post(`/api/admin/courses/${courseB}/assignments`).send({ user_id: fx.A.learner.id }).expect(404);
      expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [fx.A.learner.id, courseB])).toHaveLength(0);
    });

    it('issuing a certificate to another org learner or for another org course is 404', async () => {
      await adminB.post('/api/admin/certificates').send({ userId: fx.A.learner.id, courseId: courseB }).expect(404);
      await adminB.post('/api/admin/certificates').send({ userId: fx.B.learner.id, courseId: courseA }).expect(404);
    });

    it('a manager, role or trainer id from org A is refused in org B', async () => {
      await adminB.post('/api/admin/users').send({ first_name: 'X', last_name: 'Y', email: `${uniq('x')}@org-b.e2e.test`, manager_id: fx.A.manager.id }).expect(404);
      await adminB.patch(`/api/admin/users/${fx.B.learner2.id}/role`).send({ roleId: fx.A.roles.manager }).expect(404);
      const s = await adminB.post('/api/admin/sessions').send({
        title: uniq('cross trainer'), trainer: 'T', trainer_user_id: fx.A.trainer.id,
        venue_url: 'Room', date: new Date().toISOString().slice(0, 10), start_time: '10:00', end_time: '11:00',
      });
      expect(s.status).toBeGreaterThanOrEqual(400);
      expect(s.status).not.toBe(500);
      expect(await dbQuery('SELECT 1 FROM sessions WHERE organization_id = $1 AND trainer_user_id = $2', [fx.B.id, fx.A.trainer.id])).toHaveLength(0);
    });
  });

  describe('5. platform routes are platform-only', () => {
    it('tenant admins and learners get 403 on every platform route; the platform admin gets 200', async () => {
      const routes = [
        '/api/platform/organizations',
        `/api/platform/organizations/${fx.A.publicId}`,
        '/api/platform/organizations/tenants',
        '/api/platform/organizations/access',
        '/api/platform/analytics',
        '/api/platform/seats/requests',
        `/api/platform/organizations/${fx.A.id}/options`,
        `/api/platform/organizations/${fx.A.publicId}/roles`,
        '/api/platform/geo/countries',
      ];
      for (const path of routes) {
        expect({ path, s: (await sa.get(path)).status }).toEqual({ path, s: 200 });
        for (const who of [adminA, adminB, learnerA]) {
          expect({ path, s: (await who.get(path)).status }).toEqual({ path, s: 403 });
        }
      }
      // A tenant admin cannot reach its OWN org through a platform write either.
      await adminA.patch(`/api/platform/organizations/${fx.A.publicId}`).send({ isActive: false }).expect(403);
      await adminA.put(`/api/platform/seats/organizations/${fx.A.id}`).send({ seat_limit: 1000 }).expect(403);
      const [a] = await dbQuery('SELECT is_active, seat_limit FROM organizations WHERE id = $1', [fx.A.id]);
      expect(a).toEqual({ is_active: 1, seat_limit: 5000 });
    });
  });

  describe("6. writes land in the caller's org", () => {
    it('course, person, certificate, session and module rows carry the caller org, whatever the body says', async () => {
      const c = await adminB.post('/api/admin/courses').send({ name: uniq('Write B'), organization_id: fx.A.id, organizationId: fx.A.id });
      expect(c.status).toBe(201);
      const [course] = await dbQuery('SELECT organization_id FROM courses WHERE id = $1', [c.body.course.id]);
      expect(course.organization_id).toBe(fx.B.id);

      const email = `${uniq('w')}@org-b.e2e.test`;
      await adminB.post('/api/admin/users').send({ first_name: 'W', last_name: 'B', email, organization_id: fx.A.id }).expect(201);
      const [u] = await dbQuery('SELECT organization_id FROM users WHERE email = $1', [email]);
      expect(u.organization_id).toBe(fx.B.id);

      const [cert] = await dbQuery('SELECT organization_id FROM certificates WHERE id = $1', [certA]);
      expect(cert.organization_id).toBe(fx.A.id);
      const [sess] = await dbQuery('SELECT organization_id FROM sessions WHERE id = $1', [sessionA]);
      expect(sess.organization_id).toBe(fx.A.id);
      const [mod] = await dbQuery('SELECT c.organization_id FROM course_modules m JOIN courses c ON c.id = m.course_id WHERE m.id = $1', [moduleA]);
      expect(mod.organization_id).toBe(fx.A.id);
    });
  });

  describe('7. the learning community is org-scoped', () => {
    it('org B cannot see, read, reply to, like or moderate an org A post', async () => {
      await learnerA.get(`/api/learner/community/${postA}`).expect(200);
      const feedB = await learnerB.get('/api/learner/community').expect(200);
      expect(feedB.body.posts.map((p: { id: string }) => p.id)).not.toContain(postA);
      await learnerB.get(`/api/learner/community/${postA}`).expect(404);
      await learnerB.post(`/api/learner/community/${postA}/replies`).send({ body: 'nope' }).expect(404);
      await learnerB.post(`/api/learner/community/${postA}/like`).expect(404);
      await learnerB.delete(`/api/learner/community/${postA}`).expect(404);

      const modB = await adminB.get('/api/admin/community').expect(200);
      expect(modB.body.posts.map((p: { id: string }) => p.id)).not.toContain(postA);
      await adminB.get(`/api/admin/community/${postA}`).expect(404);
      await adminB.delete(`/api/admin/community/${postA}`).expect(404);
      const modA = await adminA.get('/api/admin/community').expect(200);
      expect(modA.body.posts.map((p: { id: string }) => p.id)).toContain(postA);
      const [row] = await dbQuery('SELECT deleted_at, reply_count, like_count FROM community_posts WHERE public_id = $1', [postA]);
      expect(row).toEqual({ deleted_at: null, reply_count: 0, like_count: 0 });
    });
  });

  describe('8. private uploads are never served publicly', () => {
    const root = () => process.env.UPLOAD_STORAGE_PATH as string;
    const place = (dir: string, name: string, bytes: Buffer | string) => {
      mkdirSync(join(root(), dir), { recursive: true });
      writeFileSync(join(root(), dir, name), bytes);
      return join(root(), dir, name);
    };

    it.each(['external-certifications', 'shared'])('a file stored in %s is NOT served at /uploads without sign-in', async (dir) => {
      const name = `${randomUUID()}.pdf`;
      const file = place(dir, name, '%PDF-1.4 isolation canary');
      try {
        await anon(app).get(`/uploads/${dir}/${name}`).expect(404);
        // Signed in makes no difference: the folder is not mounted at all.
        await adminA.get(`/uploads/${dir}/${name}`).expect(404);
      } finally {
        rmSync(file, { force: true });
      }
    });

    it.each(['course-thumbnails', 'avatars'])('a file in the public %s folder is served', async (dir) => {
      const name = `${randomUUID()}.png`;
      const file = place(dir, name, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      try {
        await anon(app).get(`/uploads/${dir}/${name}`).expect(200);
      } finally {
        rmSync(file, { force: true });
      }
    });

    it('the uploads root and a traversal are not served', async () => {
      const name = `${randomUUID()}.pdf`;
      const file = place('shared', name, '%PDF-1.4 canary');
      try {
        await anon(app).get('/uploads/').expect(404);
        await anon(app).get(`/uploads/course-thumbnails/..%2Fshared%2F${name}`).expect(404);
        await anon(app).get(`/uploads/avatars/../shared/${name}`).expect(404);
      } finally {
        rmSync(file, { force: true });
      }
    });
  });
});

function ok200or404(status: number) {
  expect([200, 404]).toContain(status);
}

function ids2(rows: { id: number }[] | undefined): number[] {
  return (rows ?? []).map((r) => r.id);
}
