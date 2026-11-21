/**
 * SCORM (CONTEXT.md §5): packages live in R2 object storage, which the test
 * environment does not configure, so an upload answers 503 naming what is
 * missing. Everything that does not touch the bytes is exercised against a
 * package row written directly: the library, assigning, the learner's
 * tracking (resume record, attempts) and the step-by-step data-model log.
 */
import { randomUUID } from 'node:crypto';

import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent, type Person } from './helpers';

describe('scorm', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  const made: number[] = [];

  const person = async (): Promise<Person> => {
    const p = await newPerson(adminA, fx.A);
    made.push(p.id);
    return p;
  };

  /** A package row as an upload would leave it (no R2 prefix, claimed). */
  const makePackage = async (orgId = fx.A.id, createdBy = fx.A.admin.id) => {
    const title = uniq('Pkg');
    const [row] = await dbQuery<{ id: number; public_id: string }>(
      `INSERT INTO scorm_packages (title, version, entry_point, package_dir, organization_id, created_by, duration_minutes)
       VALUES ($1, '1.2', 'index.html', $2, $3, $4, 20) RETURNING id, public_id`,
      [title, randomUUID(), orgId, createdBy],
    );
    return { id: row.id, publicId: row.public_id, title };
  };

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
  });
  afterAll(async () => {
    if (made.length) await dbQuery('UPDATE users SET is_active = 0 WHERE id = ANY($1)', [made]);
    await app.close();
  });

  it('upload needs object storage: without R2 it answers 503 naming what is missing (env-limited)', async () => {
    const zip = Buffer.from('PK\u0003\u0004 not really a zip');
    const r = await adminA.post('/api/admin/scorm/upload').field('title', 'x').attach('scorm_package', zip, { filename: 'pkg.zip', contentType: 'application/zip' });
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/not configured.*R2/);
    // Validation still comes first, and the guard before that.
    expect((await adminA.post('/api/admin/scorm/upload').field('title', 'x')).status).toBe(422);
    await learnerA.post('/api/admin/scorm/upload').attach('scorm_package', zip, { filename: 'pkg.zip' }).expect(403);
    expect(await dbQuery("SELECT 1 FROM scorm_packages WHERE title = 'x'")).toHaveLength(0);
  });

  it('lists and reads the library, org-scoped', async () => {
    const pkg = await makePackage();
    const list = await adminA.get('/api/admin/scorm').expect(200);
    expect(list.body.packages.map((p: { id: number }) => Number(p.id))).toContain(pkg.id);
    expect((await adminB.get('/api/admin/scorm').expect(200)).body.packages.map((p: { id: number }) => Number(p.id))).not.toContain(pkg.id);
    await learnerA.get('/api/admin/scorm').expect(403);

    const d = await adminA.get(`/api/admin/scorm/${pkg.id}`).expect(200);
    expect(d.body.package.title).toBe(pkg.title);
    expect(d.body.assignments).toEqual([]);
    await adminB.get(`/api/admin/scorm/${pkg.id}`).expect(404);
  });

  it('assigns learners, who launch, track, log the data model and can be read back by the admin', async () => {
    const pkg = await makePackage();
    const p = await person();
    const outsider = await person();

    await learnerA.post(`/api/admin/scorm/${pkg.id}/assign`).send({ user_ids: [p.id] }).expect(403);
    await adminA.post(`/api/admin/scorm/${pkg.id}/assign`).send({ user_ids: [p.id, fx.B.learner.id] }).expect(404);
    await adminA.post(`/api/admin/scorm/${pkg.id}/assign`).send({}).expect(422);
    await adminB.post(`/api/admin/scorm/${pkg.id}/assign`).send({ user_ids: [fx.B.learner.id] }).expect(404);
    const a = await adminA.post(`/api/admin/scorm/${pkg.id}/assign`).send({ user_ids: [p.id] }).expect(200);
    expect(a.body).toEqual({ assigned: 1, total: 1 });
    expect((await adminA.get(`/api/admin/scorm/${pkg.id}`)).body.assignments).toHaveLength(1);

    const me = await signIn(app, p);
    const mine = await me.get('/api/learner/scorm').expect(200);
    expect(mine.body.packages.map((x: { id: number }) => Number(x.id))).toContain(pkg.id);
    const detail = await me.get(`/api/learner/scorm/${pkg.publicId}`).expect(200);
    expect(detail.body.package.title).toBe(pkg.title);
    expect((await me.get(`/api/learner/scorm/${pkg.publicId}/tracking`).expect(200)).body.tracking).toBeFalsy();

    // Not assigned: no launch, no tracking.
    const them = await signIn(app, outsider);
    expect((await them.get('/api/learner/scorm')).body.packages.map((x: { id: number }) => Number(x.id))).not.toContain(pkg.id);
    await them.get(`/api/learner/scorm/${pkg.publicId}`).expect(404);
    await them.post(`/api/learner/scorm/${pkg.publicId}/tracking`).send({ cmi_data: { core: { lesson_status: 'completed' } } }).expect(403);
    await (await signIn(app, fx.B.learner)).get(`/api/learner/scorm/${pkg.publicId}`).expect(404);

    // A sitting in progress, then finished.
    await me.post(`/api/learner/scorm/${pkg.publicId}/tracking`).send({ cmi_data: { core: { lesson_status: 'incomplete', lesson_location: 'p3', score: { raw: 40 } }, suspend_data: 'abc' } }).expect(200);
    const t1 = await me.get(`/api/learner/scorm/${pkg.publicId}/tracking`).expect(200);
    expect(t1.body.tracking).toEqual(expect.objectContaining({ lesson_status: 'incomplete' }));
    await me.post(`/api/learner/scorm/${pkg.publicId}/tracking`).send({ cmi_data: { core: { lesson_status: 'passed', score: { raw: 85, max: 100 }, total_time: '00:10:00' } } }).expect(200);
    const [tr] = await dbQuery('SELECT lesson_status, success_status, completion_status, organization_id FROM scorm_tracking WHERE user_id = $1 AND package_id = $2', [p.id, pkg.id]);
    expect(tr).toEqual({ lesson_status: 'passed', success_status: 'passed', completion_status: 'completed', organization_id: fx.A.id });
    await me.post(`/api/learner/scorm/${pkg.publicId}/tracking`).send({}).expect(400);

    // The data-model log: written in one batch, org and attempt resolved server-side.
    const dm = await me.post(`/api/learner/scorm/${pkg.publicId}/datamodel`).send({ deltas: [
      { element_key: 'cmi.core.lesson_status', element_value: 'incomplete' },
      { element_key: 'cmi.core.score.raw', element_value: '85' },
    ] }).expect(200);
    expect(dm.body.tracked).toBe(2);
    await me.post(`/api/learner/scorm/${pkg.publicId}/datamodel`).send({ deltas: [{ element_key: 'not a path!', element_value: 'x' }] }).expect(400);
    await them.post(`/api/learner/scorm/${pkg.publicId}/datamodel`).send({ deltas: [{ element_key: 'cmi.core.lesson_status', element_value: 'x' }] }).expect((r) => expect([403, 404]).toContain(r.status));
    const log = await me.get(`/api/learner/scorm/${pkg.publicId}/datamodel`).query({ limit: 10 }).expect(200);
    expect(log.body.total).toBe(2);
    expect(log.body.entries.map((e: { element_key: string }) => e.element_key).sort()).toEqual(['cmi.core.lesson_status', 'cmi.core.score.raw']);
    expect(await dbQuery('SELECT DISTINCT organization_id FROM scorm_datamodel_log WHERE user_id = $1', [p.id])).toEqual([{ organization_id: fx.A.id }]);
    await me.get(`/api/learner/scorm/${pkg.publicId}/datamodel`).query({ limit: 9999 }).expect(400);

    // The admin reads one learner's attempts and log; another org cannot.
    const att = await adminA.get(`/api/admin/scorm/${pkg.id}/attempts/${p.id}`).expect(200);
    expect(att.body.package.id).toBe(pkg.id);
    expect(att.body.attempts.length).toBeGreaterThanOrEqual(1);
    expect(att.body.attempts[0]).toEqual(expect.objectContaining({ lesson_status: 'passed', is_passed: true }));
    await adminB.get(`/api/admin/scorm/${pkg.id}/attempts/${p.id}`).expect(404);
    await adminA.get(`/api/admin/scorm/${pkg.id}/attempts/${fx.B.learner.id}`).expect(404);
    const alog = await adminA.get(`/api/admin/scorm/${pkg.id}/datamodel/${p.id}`).expect(200);
    expect(alog.body.total).toBe(2);
    await adminB.get(`/api/admin/scorm/${pkg.id}/datamodel/${p.id}`).expect(404);
    await learnerA.get(`/api/admin/scorm/${pkg.id}/datamodel/${p.id}`).expect(403);

    // Unassigning ends access.
    await learnerA.delete(`/api/admin/scorm/${pkg.id}/assign`).send({ user_id: p.id }).expect(403);
    await adminA.delete(`/api/admin/scorm/${pkg.id}/assign`).send({ user_id: p.id }).expect(200);
    expect(await dbQuery('SELECT 1 FROM user_scorm_assignments WHERE user_id = $1 AND package_id = $2', [p.id, pkg.id])).toHaveLength(0);
    await me.get(`/api/learner/scorm/${pkg.publicId}`).expect(404);
  });

  it('deletes a package and its tracking; another org and a learner are refused', async () => {
    const pkg = await makePackage();
    const p = await person();
    await adminA.post(`/api/admin/scorm/${pkg.id}/assign`).send({ user_ids: [p.id] }).expect(200);
    await adminB.delete(`/api/admin/scorm/${pkg.id}`).expect(404);
    await learnerA.delete(`/api/admin/scorm/${pkg.id}`).expect(403);
    await adminA.delete(`/api/admin/scorm/${pkg.id}`).expect(200);
    expect(await dbQuery('SELECT 1 FROM scorm_packages WHERE id = $1', [pkg.id])).toHaveLength(0);
    expect(await dbQuery('SELECT 1 FROM user_scorm_assignments WHERE package_id = $1', [pkg.id])).toHaveLength(0);
  });
});
