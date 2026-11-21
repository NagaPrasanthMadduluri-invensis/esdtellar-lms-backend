/**
 * External certifications (CONTEXT.md §8, §18.6): a learner claims training
 * done elsewhere with a scan, their Manager confirms, an Admin approves or
 * declines with a reason. Nothing counts before approval; approval adds a
 * completed companion course and hours, but no Points and no Certificate.
 * The scan is a Private file, readable only by owner, their manager and an
 * admin of that org.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent, type Person } from './helpers';
import { makeCourse, notificationsOf, PDF_BYTES, settle } from './support/3';

describe('external certifications', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let managerA: Agent;
  let learnerA: Agent;
  const made: number[] = [];

  const person = async (extra: Record<string, unknown> = {}): Promise<Person> => {
    const p = await newPerson(adminA, fx.A, 'learner', extra);
    made.push(p.id);
    return p;
  };

  const submit = (agent: Agent, courseName = uniq('AWS Cloud'), file: Buffer | null = PDF_BYTES, mime = 'application/pdf') => {
    const req = agent.post('/api/learner/external-certifications')
      .field('name_on_certificate', 'Jane Q Temp')
      .field('course_name', courseName)
      .field('course_hours', '1.5')
      .field('authorized_body', 'Amazon Web Services');
    return file ? req.attach('file', file, { filename: 'cert.pdf', contentType: mime }) : req;
  };

  /** A learner reporting to the fixture manager, signed in. */
  const managed = async () => {
    const p = await person({ manager_id: fx.A.manager.id });
    return { p, me: await signIn(app, p) };
  };

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    managerA = await signIn(app, fx.A.manager);
    learnerA = await signIn(app, fx.A.learner);
  });
  afterAll(async () => {
    if (made.length) await dbQuery('UPDATE users SET is_active = 0 WHERE id = ANY($1)', [made]);
    await app.close();
  });

  it('submitting a claim stores the scan and creates nothing else; the manager is told', async () => {
    const { p, me } = await managed();
    const before = (await me.get('/api/learner/dashboard').expect(200)).body;
    const name = uniq('Claim');
    const r = await submit(me, name).expect(201);
    expect(r.body.certification).toEqual(expect.objectContaining({
      user_id: p.id, course_name: name, course_hours: 1.5, course_minutes: 90, status: 'pending_manager',
      manager_user_id: fx.A.manager.id, file_mime: 'application/pdf', course_id: null,
    }));
    expect(r.body.sent_to).toMatch(/your manager/);
    // The internal path never leaves the server.
    expect(JSON.stringify(r.body)).not.toMatch(/external-certifications\/[0-9a-f-]{36}/);

    await settle();
    expect((await notificationsOf(fx.A.manager.id, 'external_cert_submitted')).some((n) => `${n.title} ${n.body}`.includes(name))).toBe(true);
    // Nothing counts yet.
    const after = (await me.get('/api/learner/dashboard').expect(200)).body;
    expect(after.stats.completed_courses).toBe(before.stats.completed_courses);
    expect(await dbQuery('SELECT 1 FROM courses WHERE name = $1', [name])).toHaveLength(0);

    const mine = await me.get('/api/learner/external-certifications').expect(200);
    expect(mine.body.certifications.map((c: { id: number }) => c.id)).toEqual([r.body.certification.id]);
    await adminA.get('/api/learner/external-certifications').expect(403);
  });

  it('refuses a claim with no file, or with bytes that are not the declared type', async () => {
    const { me } = await managed();
    await submit(me, uniq('NoFile'), null).expect(400);
    const fake = Buffer.from('<html><script>alert(1)</script></html>');
    const r = await submit(me, uniq('Fake'), fake);
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/not a valid PDF/);
  });

  it('manager confirms, the admin cannot skip ahead of them, then approves: completed course and hours, no points, no certificate', async () => {
    const { p, me } = await managed();
    const name = uniq('Approved');
    const id = (await submit(me, name).expect(201)).body.certification.id;
    const before = (await me.get('/api/learner/dashboard').expect(200)).body;

    // An admin cannot skip a pending manager.
    const skip = await adminA.patch(`/api/admin/external-certifications/${id}`).send({ approve: true });
    expect(skip.status).toBe(422);
    expect(skip.body.message).toMatch(/has not confirmed/);

    const team = await managerA.get('/api/learner/team/external-certifications').expect(200);
    expect(team.body.certifications.map((c: { id: number }) => c.id)).toContain(id);
    // A learner without view_team_learning has no team queue.
    await learnerA.get('/api/learner/team/external-certifications').expect(403);
    await learnerA.patch(`/api/learner/team/external-certifications/${id}`).send({ approve: true }).expect(403);

    const conf = await managerA.patch(`/api/learner/team/external-certifications/${id}`).send({ approve: true }).expect(200);
    expect(conf.body.certification.status).toBe('pending_admin');
    await settle();
    expect(await notificationsOf(p.id, 'external_cert_confirmed')).toHaveLength(1);
    expect((await notificationsOf(fx.A.admin.id, 'external_cert_ready')).length).toBeGreaterThan(0);
    // The manager's step is done.
    await managerA.patch(`/api/learner/team/external-certifications/${id}`).send({ approve: true }).expect(422);

    const queue = await adminA.get('/api/admin/external-certifications').query({ status: 'pending_admin' }).expect(200);
    expect(queue.body.certifications.map((c: { id: number }) => c.id)).toContain(id);
    expect(queue.body.counts.pending_admin).toBeGreaterThan(0);
    await adminB.patch(`/api/admin/external-certifications/${id}`).send({ approve: true }).expect(404);
    expect((await adminB.get('/api/admin/external-certifications').expect(200)).body.certifications.map((c: { id: number }) => c.id)).not.toContain(id);
    await learnerA.get('/api/admin/external-certifications').expect(403);

    const ok = await adminA.patch(`/api/admin/external-certifications/${id}`).send({ approve: true }).expect(200);
    expect(ok.body.certification.status).toBe('approved');
    const courseId = ok.body.certification.course_id;
    expect(courseId).toEqual(expect.any(Number));
    await settle();
    expect(await notificationsOf(p.id, 'external_cert_approved')).toHaveLength(1);

    // A completed companion course worth the claimed 90 minutes, assigned and done.
    const [course] = await dbQuery('SELECT external_certification_id FROM courses WHERE id = $1', [courseId]);
    expect(course.external_certification_id).toBe(id);
    expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, courseId])).toHaveLength(1);
    const done = await dbQuery('SELECT l.duration_minutes FROM user_lesson_completions c JOIN lessons l ON l.id = c.lesson_id WHERE c.user_id = $1 AND l.course_id = $2', [p.id, courseId]);
    expect(done).toEqual([{ duration_minutes: 90 }]);
    const after = (await me.get('/api/learner/dashboard').expect(200)).body;
    expect(after.stats.completed_courses).toBe(before.stats.completed_courses + 1);
    expect(after.stats.hours_all_time).toBeCloseTo(before.stats.hours_all_time + 1.5, 1);
    // No points and no certificate in this product's name.
    expect(after.points).toBe(before.points);
    expect(await dbQuery('SELECT 1 FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, courseId])).toHaveLength(0);

    // Already decided.
    await adminA.patch(`/api/admin/external-certifications/${id}`).send({ approve: true }).expect(422);

    // An approved certification is an undeliverable path step.
    const other = await makeCourse(adminA);
    const j = await adminA.post('/api/admin/journeys').send({ title: uniq('Path'), badge_label: 'x' }).expect(201);
    const bad = await adminA.put(`/api/admin/journeys/${j.body.journey.id}/courses`).send({ courses: [{ course_id: other.id }, { course_id: courseId }] });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toContain(name);
  });

  it('a decline needs a reason, from the manager or the admin, and the learner is told', async () => {
    const { p, me } = await managed();
    const id1 = (await submit(me).expect(201)).body.certification.id;
    const noReason = await managerA.patch(`/api/learner/team/external-certifications/${id1}`).send({ approve: false });
    expect(noReason.status).toBe(422);
    expect(noReason.body.message).toMatch(/^note/);
    const dec = await managerA.patch(`/api/learner/team/external-certifications/${id1}`).send({ approve: false, note: 'Not the same course' }).expect(200);
    expect(dec.body.certification).toEqual(expect.objectContaining({ status: 'rejected', manager_note: 'Not the same course' }));
    await settle();
    expect(await notificationsOf(p.id, 'external_cert_rejected')).toHaveLength(1);

    const id2 = (await submit(me).expect(201)).body.certification.id;
    await managerA.patch(`/api/learner/team/external-certifications/${id2}`).send({ approve: true }).expect(200);
    await adminA.patch(`/api/admin/external-certifications/${id2}`).send({ approve: false }).expect(422);
    const r = await adminA.patch(`/api/admin/external-certifications/${id2}`).send({ approve: false, note: 'Scan unreadable' }).expect(200);
    expect(r.body.certification).toEqual(expect.objectContaining({ status: 'rejected', admin_note: 'Scan unreadable', course_id: null }));
  });

  it('with no manager the claim goes straight to L&D, and only the manager it was sent to may confirm', async () => {
    const p = await person();
    const me = await signIn(app, p);
    const r = await submit(me).expect(201);
    expect(r.body.certification.status).toBe('pending_admin');
    expect(r.body.sent_to).toMatch(/no manager/);
    // The fixture manager is not this learner's manager.
    await managerA.patch(`/api/learner/team/external-certifications/${r.body.certification.id}`).send({ approve: true }).expect(403);
    await adminA.patch(`/api/admin/external-certifications/${r.body.certification.id}`).send({ approve: true }).expect(200);
  });

  it('the scan opens for its owner, their manager and an admin of that org only', async () => {
    const { me } = await managed();
    const id = (await submit(me).expect(201)).body.certification.id;
    const owner = await me.get(`/api/external-certifications/${id}/file`).expect(200);
    expect(owner.headers['content-type']).toMatch(/application\/pdf/);
    expect(owner.headers['content-disposition']).toMatch(/inline; filename="cert.pdf"/);
    expect(Buffer.from(owner.body).subarray(0, 5).toString()).toBe('%PDF-');
    await managerA.get(`/api/external-certifications/${id}/file`).expect(200);
    await adminA.get(`/api/external-certifications/${id}/file`).expect(200);

    await learnerA.get(`/api/external-certifications/${id}/file`).expect(403);
    await (await signIn(app, fx.A.trainer)).get(`/api/external-certifications/${id}/file`).expect(403);
    await adminB.get(`/api/external-certifications/${id}/file`).expect(404);
    await (await signIn(app, fx.B.learner)).get(`/api/external-certifications/${id}/file`).expect(404);
  });
});
