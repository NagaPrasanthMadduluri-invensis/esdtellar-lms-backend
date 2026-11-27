/**
 * Certificates (CONTEXT.md §8): automatic issue on Course completion, issue by
 * hand (completion re-checked), Revoke, Reinstate with a new code, the learner
 * document, and the public Verify page (unknown codes answered, rate limited).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, newPerson, signIn, type Agent, type Person } from './helpers';
import { assignCourse, completeCourse, makeCourse, makeSession, notificationsOf, settle } from './support/3';

describe('certificates', () => {
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

  /** A learner who has completed a one-lesson course, so a certificate was auto-issued. */
  const completed = async () => {
    const course = await makeCourse(adminA, { lessons: 1 });
    const p = await person();
    await assignCourse(adminA, course.id, [p.id]);
    const me = await signIn(app, p);
    await completeCourse(me, course);
    const [cert] = await dbQuery('SELECT id, certificate_code, public_id, is_revoked, organization_id FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, course.id]);
    return { course, p, me, cert };
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

  it('completing a course issues a certificate with a ten-character code in the learner\'s org, and tells them', async () => {
    const { p, cert, me, course } = await completed();
    expect(cert).toBeDefined();
    expect(cert.certificate_code).toMatch(/^EDS[0-9A-F]{7}$/);
    expect(cert.organization_id).toBe(fx.A.id);
    expect(cert.is_revoked).toBe(0);
    await settle();
    expect((await notificationsOf(p.id, 'certificate_issued')).length).toBe(1);

    const list = await me.get('/api/learner/certificates').expect(200);
    expect(list.body.certificates).toEqual([expect.objectContaining({ id: cert.id, certificateCode: cert.certificate_code, courseName: course.name, kind: 'course', isRevoked: false })]);

    const doc = await me.get(`/api/learner/certificates/${cert.public_id}`).expect(200);
    expect(doc.body.certificate).toEqual(expect.objectContaining({ id: cert.id }));
    expect(doc.body.certificate.verifyUrl).toMatch(new RegExp(`/verify/${cert.certificate_code}$`));
    expect(doc.body.certificate.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    // Never a score on the document's kind block, and nobody else's certificate.
    await learnerA.get(`/api/learner/certificates/${cert.public_id}`).expect(403);
    await (await signIn(app, fx.B.learner)).get(`/api/learner/certificates/${cert.public_id}`).expect(404);
    await adminA.get('/api/learner/certificates').expect(403);
  });

  it('the admin list is org-scoped and needs view_certificates', async () => {
    const { p, cert, course } = await completed();
    const all = await adminA.get('/api/admin/certificates').expect(200);
    expect(all.body.certificates.map((c: { id: number }) => c.id)).toContain(cert.id);
    const filtered = await adminA.get('/api/admin/certificates').query({ userId: p.id, courseId: course.id }).expect(200);
    expect(filtered.body.certificates.map((c: { id: number }) => c.id)).toEqual([cert.id]);
    const b = await adminB.get('/api/admin/certificates').expect(200);
    expect(b.body.certificates.map((c: { id: number }) => c.id)).not.toContain(cert.id);
    await learnerA.get('/api/admin/certificates').expect(403);
  });

  it('public verify shows the holder but no email, and an unknown code gets an answer, not an error', async () => {
    const { p, cert, course } = await completed();
    const v = await anon(app).get(`/api/certificates/verify/${cert.certificate_code}`).expect(200);
    expect(v.body).toEqual(expect.objectContaining({
      found: true, valid: true, isRevoked: false, kind: 'course', title: course.name,
      learnerName: `${p.firstName} Temp`, organizationName: 'Org A E2E',
    }));
    expect(JSON.stringify(v.body)).not.toContain(p.email);

    const u = await anon(app).get('/api/certificates/verify/NOPE123456').expect(200);
    expect(u.body).toEqual(expect.objectContaining({ found: false, valid: false, learnerName: null }));
  });

  it('revoke keeps the row and shows revoked on verify; reinstate gives a new code and the old one stops verifying', async () => {
    const { cert, me } = await completed();
    await learnerA.delete(`/api/admin/certificates/${cert.id}`).expect(403);
    await adminB.delete(`/api/admin/certificates/${cert.id}`).expect(404);
    await adminA.patch(`/api/admin/certificates/${cert.id}`).expect(409); // not revoked yet

    await adminA.delete(`/api/admin/certificates/${cert.id}`).expect(200);
    const [row] = await dbQuery('SELECT is_revoked, revoked_by FROM certificates WHERE id = $1', [cert.id]);
    expect(row).toEqual({ is_revoked: 1, revoked_by: fx.A.admin.id });
    const v = await anon(app).get(`/api/certificates/verify/${cert.certificate_code}`).expect(200);
    expect(v.body).toEqual(expect.objectContaining({ found: true, valid: false, isRevoked: true }));
    expect((await me.get('/api/learner/certificates')).body.certificates[0].isRevoked).toBe(true);

    await adminB.patch(`/api/admin/certificates/${cert.id}`).expect(404);
    const re = await adminA.patch(`/api/admin/certificates/${cert.id}`).expect(200);
    expect(re.body.certificate.isRevoked).toBe(false);
    expect(re.body.certificate.certificateCode).not.toBe(cert.certificate_code);
    expect((await anon(app).get(`/api/certificates/verify/${cert.certificate_code}`)).body.found).toBe(false);
    expect((await anon(app).get(`/api/certificates/verify/${re.body.certificate.certificateCode}`)).body.valid).toBe(true);
  });

  it('issue by hand re-checks completion, refuses a duplicate, and reinstates a revoked one rather than making a second', async () => {
    const course = await makeCourse(adminA, { lessons: 2 });
    const p = await person();
    await assignCourse(adminA, course.id, [p.id]);

    await learnerA.post('/api/admin/certificates').send({ userId: p.id, courseId: course.id }).expect(403);
    await adminB.post('/api/admin/certificates').send({ userId: p.id, courseId: course.id }).expect(404);

    const r = await adminA.post('/api/admin/certificates').send({ userId: p.id, courseId: course.id }).expect(201);
    // Not finished: issued anyway, and the response says so.
    expect(r.body).toEqual({ ok: true, certificate: expect.objectContaining({ userId: p.id, courseId: course.id, hadCompleted: false, reinstated: false, isRevoked: false }) });
    const certId = r.body.certificate.id;

    await adminA.post('/api/admin/certificates').send({ userId: p.id, courseId: course.id }).expect(409);

    await adminA.delete(`/api/admin/certificates/${certId}`).expect(200);
    const again = await adminA.post('/api/admin/certificates').send({ userId: p.id, courseId: course.id }).expect(201);
    expect(again.body.certificate).toEqual(expect.objectContaining({ id: certId, reinstated: true, isRevoked: false }));
    expect(await dbQuery('SELECT 1 FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, course.id])).toHaveLength(1);
  });

  it('issue by hand for a finished course reports hadCompleted', async () => {
    const course = await makeCourse(adminA, { lessons: 1 });
    const p = await person();
    await assignCourse(adminA, course.id, [p.id]);
    await completeCourse(await signIn(app, p), course);
    // Auto-issued on completion; revoke it and issue by hand to read the re-check.
    const [cert] = await dbQuery('SELECT id FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, course.id]);
    await adminA.delete(`/api/admin/certificates/${cert.id}`).expect(200);
    const r = await adminA.post('/api/admin/certificates').send({ userId: p.id, courseId: course.id }).expect(201);
    expect(r.body.certificate).toEqual(expect.objectContaining({ hadCompleted: true, reinstated: true }));
  });

  it('completing a session issues its certificate (§10.66), printed "Online" for a virtual one; by hand it is a 409, or a reinstate once revoked', async () => {
    const s = await makeSession(adminA, fx.A, { session_type: 'Virtual', venue_url: 'https://meet.example.test/cert' });
    const p = await person();
    await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);
    await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: p.id, status: 'present' }] }).expect(200);
    await adminA.post(`/api/admin/sessions/${s.id}/complete`).expect(200);
    const issued = await dbQuery('SELECT id, public_id, certificate_code FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, s.trainingCourseId]);
    expect(issued).toHaveLength(1);

    // Already held: issuing by hand refuses; once revoked, by hand reinstates the same row.
    await adminA.post('/api/admin/certificates').send({ userId: p.id, courseId: s.trainingCourseId }).expect(409);
    await adminA.delete(`/api/admin/certificates/${issued[0].id}`).expect(200);
    const r = await adminA.post('/api/admin/certificates').send({ userId: p.id, courseId: s.trainingCourseId }).expect(201);
    expect(r.body.certificate).toEqual(expect.objectContaining({ reinstated: true, hadCompleted: true }));
    // Reinstating re-issues under a fresh code, so read the row again.
    const [cert] = await dbQuery('SELECT public_id, certificate_code FROM certificates WHERE id = $1', [issued[0].id]);
    const doc = await (await signIn(app, p)).get(`/api/learner/certificates/${cert.public_id}`).expect(200);
    expect(doc.body.certificate.kind).toBe('session');
    expect(doc.body.certificate.session).toEqual(expect.objectContaining({ format: 'Virtual', venue: 'Online' }));
    expect(JSON.stringify(doc.body)).not.toContain('meet.example.test');
    const v = await anon(app).get(`/api/certificates/verify/${cert.certificate_code}`).expect(200);
    expect(v.body.kind).toBe('session');
  });

  it('a Webinar session certificate prints "Online" as the venue and "Virtual" as the format (CONTEXT: Webinar is virtual)', async () => {
    const s = await makeSession(adminA, fx.A, { session_type: 'Webinar', venue_url: 'https://meet.example.test/webinar' });
    const p = await person();
    await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);
    await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: p.id, status: 'present' }] }).expect(200);
    await adminA.post(`/api/admin/sessions/${s.id}/complete`).expect(200);
    const [cert] = await dbQuery('SELECT public_id, certificate_code FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, s.trainingCourseId]);
    const doc = await (await signIn(app, p)).get(`/api/learner/certificates/${cert.public_id}`).expect(200);
    expect(doc.body.certificate.session.venue).toBe('Online');
    expect(doc.body.certificate.session.format).toBe('Virtual');
    const v = await anon(app).get(`/api/certificates/verify/${cert.certificate_code}`).expect(200);
    expect(v.body.session.format).toBe('Virtual');
  });

  // Last: it spends this process's verify budget for the test IP.
  it('rate limits the public verify page (30 a minute per IP) with Retry-After', async () => {
    let limited: { status: number; headers: Record<string, string>; body: { message: string } } | undefined;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await anon(app).get('/api/certificates/verify/RATELIMIT0');
      if (r.status === 429) limited = r as never;
      else expect(r.status).toBe(200);
    }
    expect(limited).toBeDefined();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
  });
});
