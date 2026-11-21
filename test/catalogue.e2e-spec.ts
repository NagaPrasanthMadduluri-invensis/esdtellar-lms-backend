/**
 * Course Catalogue and Self-enrolment (CONTEXT.md §6): Open courses and Open
 * sessions, the learner's own state, booking, the waitlist when full, and
 * Give up my place until Attendance is marked.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, type Agent, type Person } from './helpers';
import { makeCourse, makeSession, notificationsOf, settle } from './support/3';

describe('catalogue', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let learnerB: Agent;
  const made: number[] = [];

  const person = async (): Promise<Person> => {
    const p = await newPerson(adminA, fx.A);
    made.push(p.id);
    return p;
  };

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    learnerB = await signIn(app, fx.B.learner);
  });
  afterAll(async () => {
    if (made.length) await dbQuery('UPDATE users SET is_active = 0 WHERE id = ANY($1)', [made]);
    await app.close();
  });

  it('lists open courses and open sessions of the learner\'s own org only, with their own state', async () => {
    const open = await makeCourse(adminA, { selfEnrol: true });
    const closed = await makeCourse(adminA, { selfEnrol: false });
    const draft = await makeCourse(adminA, { selfEnrol: true, published: false });
    const s = await makeSession(adminA, fx.A, { enroll_mode: 'self', capacity: 3 });
    const assigned = await makeSession(adminA, fx.A, { enroll_mode: 'assigned' });

    const p = await person();
    const me = await signIn(app, p);
    const r = await me.get('/api/learner/catalogue').expect(200);
    const courseIds = r.body.courses.map((c: { id: number }) => Number(c.id));
    expect(courseIds).toContain(open.id);
    expect(courseIds).not.toContain(closed.id);
    expect(courseIds).not.toContain(draft.id);
    const card = r.body.courses.find((c: { id: number }) => Number(c.id) === open.id);
    expect(card).toEqual(expect.objectContaining({ is_enrolled: false, public_id: open.publicId }));

    const sessionIds = r.body.sessions.map((x: { id: number }) => Number(x.id));
    expect(sessionIds).toContain(s.id);
    expect(sessionIds).not.toContain(assigned.id);
    const sc = r.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
    expect(sc).toEqual(expect.objectContaining({ capacity: 3, seats_left: 3, is_full: false, is_enrolled: false, is_waitlisted: false }));

    // Org B's learner sees none of org A's open items.
    const b = await learnerB.get('/api/learner/catalogue').expect(200);
    expect(b.body.courses.map((c: { id: number }) => Number(c.id))).not.toContain(open.id);
    expect(b.body.sessions.map((x: { id: number }) => Number(x.id))).not.toContain(s.id);

    // Not a learner route.
    await adminA.get('/api/learner/catalogue').expect(403);
  });

  it('self-enrols in an open course: the learner is the assigner, both sides are told, and a repeat is harmless', async () => {
    const course = await makeCourse(adminA, { selfEnrol: true });
    const p = await person();
    const me = await signIn(app, p);

    const r = await me.post(`/api/learner/catalogue/courses/${course.id}/enrol`).expect(200);
    expect(r.body).toEqual({ enrolled: true, already: false, course_id: course.id });
    const [asg] = await dbQuery('SELECT assigned_by, source_journey_id, due_date FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, course.id]);
    expect(asg).toEqual({ assigned_by: p.id, source_journey_id: null, due_date: null });

    await settle();
    expect(await notificationsOf(p.id, 'course_self_enrolled')).toHaveLength(1);
    expect((await notificationsOf(fx.A.admin.id, 'self_enrolment')).length).toBeGreaterThan(0);
    // The admin notice is bell-only: no email row.
    expect(await dbQuery("SELECT 1 FROM email_outbox WHERE type = 'self_enrolment'")).toHaveLength(0);

    const again = await me.post(`/api/learner/catalogue/courses/${course.id}/enrol`).expect(200);
    expect(again.body.already).toBe(true);
    expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, course.id])).toHaveLength(1);

    const list = await me.get('/api/learner/catalogue').expect(200);
    expect(list.body.courses.find((c: { id: number }) => Number(c.id) === course.id).is_enrolled).toBe(true);
  });

  it('refuses a course that is not open, and another org\'s course', async () => {
    const closed = await makeCourse(adminA, { selfEnrol: false });
    const open = await makeCourse(adminA, { selfEnrol: true });
    const p = await person();
    const me = await signIn(app, p);
    const r = await me.post(`/api/learner/catalogue/courses/${closed.id}/enrol`);
    expect(r.status).toBe(422);
    await learnerB.post(`/api/learner/catalogue/courses/${open.id}/enrol`).expect(404);
    expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE course_id = $1', [open.id])).toHaveLength(0);
  });

  it('books an open session, gives up the place, and books again; refused once attendance is marked', async () => {
    const s = await makeSession(adminA, fx.A, { enroll_mode: 'self', capacity: 5 });
    const p = await person();
    const me = await signIn(app, p);

    const booked = await me.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
    expect(booked.body).toEqual({ state: 'enrolled', already: false, position: null });
    expect(await dbQuery('SELECT assigned_by FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, s.trainingCourseId])).toEqual([{ assigned_by: p.id }]);
    await settle();
    expect(await notificationsOf(p.id, 'session_enrolled')).toHaveLength(1);
    expect((await me.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200)).body.already).toBe(true);

    const left = await me.delete(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
    expect(left.body).toEqual({ state: 'left', was: 'enrolled' });
    expect(await dbQuery('SELECT 1 FROM session_roster WHERE session_id = $1 AND user_id = $2', [s.id, p.id])).toHaveLength(0);
    expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, s.trainingCourseId])).toHaveLength(0);
    await settle();
    expect(await notificationsOf(p.id, 'session_booking_cancelled')).toHaveLength(1);
    // Not booked any more: nothing to give up.
    await me.delete(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(404);

    await me.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
    await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: p.id, status: 'absent' }] }).expect(200);
    const refused = await me.delete(`/api/learner/catalogue/sessions/${s.id}/enrol`);
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/attendance/i);
    expect(await dbQuery('SELECT 1 FROM session_roster WHERE session_id = $1 AND user_id = $2', [s.id, p.id])).toHaveLength(1);
  });

  it('a full session queues the learner with a position, and leaving the queue is allowed', async () => {
    const s = await makeSession(adminA, fx.A, { enroll_mode: 'self', capacity: 1 });
    const first = await person();
    const second = await person();
    await (await signIn(app, first)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
    const me = await signIn(app, second);
    const r = await me.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
    expect(r.body).toEqual({ state: 'waitlisted', already: false, position: 1 });
    await settle();
    expect(await notificationsOf(second.id, 'session_waitlisted')).toHaveLength(1);

    const card = (await me.get('/api/learner/catalogue').expect(200)).body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
    expect(card).toEqual(expect.objectContaining({ is_full: true, seats_left: 0, is_waitlisted: true, waitlist_position: 1, is_enrolled: false }));

    const left = await me.delete(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
    expect(left.body).toEqual({ state: 'left', was: 'waitlisted' });
    expect(await dbQuery('SELECT 1 FROM session_waitlist WHERE session_id = $1', [s.id])).toHaveLength(0);
  });

  it('refuses an admin-assigned session, and another org\'s session', async () => {
    const assigned = await makeSession(adminA, fx.A, { enroll_mode: 'assigned' });
    const open = await makeSession(adminA, fx.A, { enroll_mode: 'self' });
    const p = await person();
    const me = await signIn(app, p);
    expect((await me.post(`/api/learner/catalogue/sessions/${assigned.id}/enrol`)).status).toBe(422);
    await learnerB.post(`/api/learner/catalogue/sessions/${open.id}/enrol`).expect(404);
    await learnerB.delete(`/api/learner/catalogue/sessions/${open.id}/enrol`).expect(404);
    await adminA.post(`/api/learner/catalogue/sessions/${open.id}/enrol`).expect(403);
  });
});
