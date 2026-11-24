/**
 * Running a Session (CONTEXT.md §6, §18.5): create with a trainer account, the
 * three formats, the Companion course, Batches, the Roster, the Waitlist and
 * admin promotion, Attendance by trainer and admin, completion credit, and
 * cancellation. Also the trainer portal and the learner calendar.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent, type Person } from './helpers';
import { makeSession, notificationsOf, sessionBody, settle } from './support/3';

describe('sessions', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let trainerA: Agent;
  const made: number[] = [];

  const person = async (role = 'learner', extra: Record<string, unknown> = {}): Promise<Person> => {
    const p = await newPerson(adminA, fx.A, role, extra);
    made.push(p.id);
    return p;
  };

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    trainerA = await signIn(app, fx.A.trainer);
  });
  afterAll(async () => {
    // Free the seats the throwaway learners used, so other specs keep room.
    if (made.length) await dbQuery('UPDATE users SET is_active = 0 WHERE id = ANY($1)', [made]);
    await app.close();
  });

  describe('creating', () => {
    it('lists the org trainers for the picker, and refuses a learner', async () => {
      const r = await adminA.get('/api/admin/sessions/trainers').expect(200);
      expect(r.body.trainers).toEqual(expect.arrayContaining([expect.objectContaining({ id: fx.A.trainer.id })]));
      expect(r.body.trainers.map((t: { id: number }) => t.id)).not.toContain(fx.B.trainer.id);
      await learnerA.get('/api/admin/sessions/trainers').expect(403);
    });

    it('refuses a new session without a trainer account', async () => {
      const body = sessionBody(fx.A);
      delete (body as Record<string, unknown>).trainer_user_id;
      const r = await adminA.post('/api/admin/sessions').send(body);
      expect(r.status).toBe(422);
      expect(r.body.message).toMatch(/trainer account/i);
    });

    it('refuses another organization\'s trainer and a learner caller', async () => {
      await adminA.post('/api/admin/sessions').send(sessionBody(fx.A, { trainer_user_id: fx.B.trainer.id })).expect(404);
      await learnerA.post('/api/admin/sessions').send(sessionBody(fx.A)).expect(403);
    });

    it.each(['ILT', 'Virtual', 'Webinar'] as const)('creates a %s session with its companion course and tells the trainer', async (type) => {
      const venue = type === 'ILT' ? 'Room 4B' : 'https://meet.example.test/abc';
      const s = await makeSession(adminA, fx.A, { session_type: type, venue_url: venue, start_time: '09:00', end_time: '10:30' });
      expect(s.session).toEqual(expect.objectContaining({ session_type: type, venue_url: venue, trainer_user_id: fx.A.trainer.id }));
      // The display name is derived from the account, not trusted from the body.
      expect(s.session.trainer).toBe('Trainer Tester');

      // Companion course: one module, one session lesson worth the scheduled 90 minutes.
      const lessons = await dbQuery('SELECT l.content_type, l.duration_minutes FROM lessons l JOIN course_modules m ON m.id = l.module_id WHERE m.course_id = $1', [s.trainingCourseId]);
      expect(lessons).toEqual([{ content_type: 'session', duration_minutes: 90 }]);

      await settle();
      const n = await notificationsOf(fx.A.trainer.id, 'session_assigned_trainer');
      expect(n.some((x) => x.title.includes(s.body.title) || (x.body ?? '').includes(s.body.title))).toBe(true);
    });

    it('rejects an unknown format', async () => {
      await adminA.post('/api/admin/sessions').send(sessionBody(fx.A, { session_type: 'Podcast' as never })).expect(400);
    });
  });

  describe('reading and editing', () => {
    it('lists, reads and edits a session; another org gets 404', async () => {
      const s = await makeSession(adminA, fx.A);
      const list = await adminA.get('/api/admin/sessions').expect(200);
      const card = list.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(card).toEqual(expect.objectContaining({ enroll_mode: 'assigned', roster_count: 0, waitlist_count: 0, batches: [], display_status: 'upcoming' }));
      expect(list.body).toHaveProperty('archived_count');

      const one = await adminA.get(`/api/admin/sessions/${s.id}`).expect(200);
      expect(one.body.session.title).toBe(s.body.title);
      await adminB.get(`/api/admin/sessions/${s.id}`).expect(404);
      expect((await adminB.get('/api/admin/sessions').expect(200)).body.sessions.map((x: { id: number }) => Number(x.id))).not.toContain(s.id);

      const before = (await notificationsOf(fx.A.trainer.id, 'session_assigned_trainer')).length;
      const put = await adminA.put(`/api/admin/sessions/${s.id}`).send({ ...s.body, venue_url: 'Room 9' }).expect(200);
      expect(put.body.session.venue_url).toBe('Room 9');
      await settle();
      // Same trainer: editing the venue does not re-announce the trainer.
      expect((await notificationsOf(fx.A.trainer.id, 'session_assigned_trainer')).length).toBe(before);

      await adminB.put(`/api/admin/sessions/${s.id}`).send({ ...s.body, venue_url: 'Hijack' }).expect(404);
      await learnerA.put(`/api/admin/sessions/${s.id}`).send(s.body).expect(403);
    });

    it('the companion course is edited only through its session', async () => {
      const s = await makeSession(adminA, fx.A);
      const r = await adminA.put(`/api/admin/courses/${s.trainingCourseId}`).send({ name: 'Renamed', is_active: true });
      expect(r.status).toBe(422);
      // A learner cannot mark the session lesson complete themselves.
      const p = await person();
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);
      const [lesson] = await dbQuery('SELECT l.id FROM lessons l WHERE l.course_id = $1', [s.trainingCourseId]);
      const me = await signIn(app, p);
      await me.post(`/api/learner/lessons/${lesson.id}/complete`).expect(403);
    });
  });

  describe('roster and batches', () => {
    it('adds by name and by department, assigns the companion course, notifies, and removing withdraws it', async () => {
      const dept = uniq('Dept');
      const a = await person('learner', { department: dept });
      const b = await person('learner', { department: dept });
      const c = await person();
      const s = await makeSession(adminA, fx.A, { session_type: 'Virtual', venue_url: 'https://meet.example.test/xyz' });

      const r1 = await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: c.id }).expect(200);
      expect(r1.body.enrolled.map((u: { id: number }) => u.id)).toEqual([c.id]);
      const r2 = await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ enroll_all: true, department: dept }).expect(200);
      expect(r2.body.enrolled.map((u: { id: number }) => u.id).sort()).toEqual([a.id, b.id, c.id].sort());
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({}).expect(400);
      await learnerA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: c.id }).expect(403);
      await adminB.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: c.id }).expect(404);

      const roster = await adminA.get(`/api/admin/sessions/${s.id}/roster`).expect(200);
      expect(roster.body.enrolled).toHaveLength(3);
      expect(roster.body.available.map((u: { id: number }) => u.id)).not.toContain(a.id);
      await adminB.get(`/api/admin/sessions/${s.id}/roster`).expect(404);

      const asg = await dbQuery('SELECT user_id FROM user_course_assignments WHERE course_id = $1', [s.trainingCourseId]);
      expect(asg.map((x) => x.user_id).sort()).toEqual([a.id, b.id, c.id].sort());

      await settle();
      const [note] = await notificationsOf(c.id, 'session_enrolled');
      // A virtual session's booking points at the join link.
      expect(note.link).toBe('https://meet.example.test/xyz');
      // c was told once even though the department add came after.
      expect(await notificationsOf(c.id, 'session_enrolled')).toHaveLength(1);

      // The learner's calendar shows the booking.
      const cal = await (await signIn(app, c)).get('/api/learner/sessions').expect(200);
      expect(cal.body.sessions.map((x: { id: number }) => Number(x.id))).toContain(s.id);

      const del = await adminA.delete(`/api/admin/sessions/${s.id}/roster`).send({ user_id: c.id }).expect(200);
      expect(del.body.enrolled.map((u: { id: number }) => u.id)).not.toContain(c.id);
      expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE course_id = $1 AND user_id = $2', [s.trainingCourseId, c.id])).toHaveLength(0);
      await learnerA.delete(`/api/admin/sessions/${s.id}/roster`).send({ user_id: a.id }).expect(403);
    });

    it('creates, edits and deletes batches and moves people between them', async () => {
      const p = await person();
      const s = await makeSession(adminA, fx.A);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);

      const b1 = await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'Morning', date: '2030-01-15', start_time: '09:00', end_time: '11:00', capacity: 5 }).expect(201);
      const b2 = await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'Later' }).expect(201);
      expect(b1.body.batch.batch_no ?? b1.body.batch.batchNo).toBe(1);
      expect(b2.body.batch.batch_no ?? b2.body.batch.batchNo).toBe(2);
      await learnerA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'x' }).expect(403);
      await adminB.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'x' }).expect(404);
      const b1id = Number(b1.body.batch.id);
      const b2id = Number(b2.body.batch.id);

      // A batch with no date reads as pending.
      const list = await adminA.get('/api/admin/sessions').expect(200);
      const card = list.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      const pending = card.batches.find((b: { id: number }) => Number(b.id) === b2id);
      expect(pending.display_status).toBe('pending');

      const up = await adminA.put(`/api/admin/sessions/batches/${b2id}`).send({ label: 'Afternoon', date: '2030-01-16', start_time: '14:00', end_time: '16:00' }).expect(200);
      expect(up.body.batch.label).toBe('Afternoon');
      await adminB.put(`/api/admin/sessions/batches/${b2id}`).send({ label: 'x' }).expect(404);

      await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: p.id, batch_id: b1id }).expect(200);
      expect((await dbQuery('SELECT batch_id FROM session_roster WHERE session_id = $1 AND user_id = $2', [s.id, p.id]))[0].batch_id).toBe(b1id);
      await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: p.id, batch_id: b2id }).expect(200);
      expect((await dbQuery('SELECT batch_id FROM session_roster WHERE session_id = $1 AND user_id = $2', [s.id, p.id]))[0].batch_id).toBe(b2id);
      // Someone not on the roster cannot be moved.
      await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: fx.A.learner2.id, batch_id: b1id }).expect(404);

      // Deleting the batch leaves the person on the session, without a sitting.
      const del = await adminA.delete(`/api/admin/sessions/batches/${b2id}`).expect(200);
      expect(del.body.message).toMatch(/stay on the session/);
      const [row] = await dbQuery('SELECT batch_id FROM session_roster WHERE session_id = $1 AND user_id = $2', [s.id, p.id]);
      expect(row.batch_id).toBeNull();
      await learnerA.delete(`/api/admin/sessions/batches/${b1id}`).expect(403);
      await adminB.delete(`/api/admin/sessions/batches/${b1id}`).expect(404);
    });
  });

  describe('waitlist', () => {
    it('a full open session queues the next booking; nobody is promoted automatically; the admin promotes', async () => {
      const first = await person();
      const second = await person();
      const third = await person();
      const s = await makeSession(adminA, fx.A, { enroll_mode: 'self', capacity: 1 });

      const a = await (await signIn(app, first)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
      expect(a.body.state).toBe('enrolled');
      const b = await (await signIn(app, second)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
      expect(b.body).toEqual(expect.objectContaining({ state: 'waitlisted', position: 1 }));
      const c = await (await signIn(app, third)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
      expect(c.body).toEqual(expect.objectContaining({ state: 'waitlisted', position: 2 }));

      const wl = await adminA.get(`/api/admin/sessions/${s.id}/waitlist`).expect(200);
      expect(wl.body.waitlist.map((w: { user_id: number }) => w.user_id)).toEqual([second.id, third.id]);
      await adminB.get(`/api/admin/sessions/${s.id}/waitlist`).expect(404);
      // A waitlisted learner is not enrolled: no companion course.
      expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE course_id = $1 AND user_id = $2', [s.trainingCourseId, second.id])).toHaveLength(0);

      // A place opens: still nobody moves up on their own.
      await adminA.delete(`/api/admin/sessions/${s.id}/roster`).send({ user_id: first.id }).expect(200);
      expect((await adminA.get(`/api/admin/sessions/${s.id}/waitlist`)).body.waitlist).toHaveLength(2);
      expect((await adminA.get(`/api/admin/sessions/${s.id}/roster`)).body.enrolled).toHaveLength(0);

      await learnerA.post(`/api/admin/sessions/${s.id}/waitlist/${second.id}/promote`).expect(403);
      await adminA.post(`/api/admin/sessions/${s.id}/waitlist/${second.id}/promote`).expect(200);
      expect((await adminA.get(`/api/admin/sessions/${s.id}/roster`)).body.enrolled.map((u: { id: number }) => u.id)).toEqual([second.id]);
      expect(await dbQuery('SELECT 1 FROM user_course_assignments WHERE course_id = $1 AND user_id = $2', [s.trainingCourseId, second.id])).toHaveLength(1);
      expect((await adminA.get(`/api/admin/sessions/${s.id}/waitlist`)).body.waitlist.map((w: { user_id: number }) => w.user_id)).toEqual([third.id]);

      await learnerA.delete(`/api/admin/sessions/${s.id}/waitlist/${third.id}`).expect(403);
      await adminA.delete(`/api/admin/sessions/${s.id}/waitlist/${third.id}`).expect(200);
      expect((await adminA.get(`/api/admin/sessions/${s.id}/waitlist`)).body.waitlist).toHaveLength(0);
      await adminA.delete(`/api/admin/sessions/${s.id}/waitlist/${third.id}`).expect(404);
    });
  });

  describe('batch scheduling, capacity and reports (0074)', () => {
    it('a multi-day session credits every day, and an end before the start is refused', async () => {
      const s = await makeSession(adminA, fx.A, { date: '2030-03-02', end_date: '2030-03-04', start_time: '09:00', end_time: '11:00' });
      const [lesson] = await dbQuery('SELECT duration_minutes FROM lessons WHERE course_id = $1', [s.trainingCourseId]);
      expect(Number(lesson.duration_minutes)).toBe(360);
      const list = await adminA.get('/api/admin/sessions').expect(200);
      const card = list.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(card.sittings).toEqual([expect.objectContaining({ batch_id: null, start_date: '2030-03-02', end_date: '2030-03-04', dates: ['2030-03-02', '2030-03-03', '2030-03-04'], total_minutes: 360 })]);
      const bad = await adminA.post('/api/admin/sessions').send(sessionBody(fx.A, { date: '2030-03-05', end_date: '2030-03-01' }));
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/end date/i);
    });

    it('batches run on the same day or across days, each with its own seats; booking needs a batch; no overbooking', async () => {
      const [l1, l2, l3, l4] = [await person(), await person(), await person(), await person()];
      const s = await makeSession(adminA, fx.A, { enroll_mode: 'self', capacity: 10 });
      const am = (await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'Morning', date: '2030-04-01', start_time: '09:00', end_time: '12:00', capacity: 1 }).expect(201)).body.batch;
      const pm = (await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'Afternoon', date: '2030-04-01', start_time: '14:00', end_time: '17:00', capacity: 1 }).expect(201)).body.batch;
      const span = (await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'Bootcamp', date: '2030-04-06', end_date: '2030-04-08', start_time: '10:00', end_time: '13:00', capacity: 5 }).expect(201)).body.batch;
      await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ date: '2030-04-09', end_date: '2030-04-02' }).expect(400);

      const a1 = await signIn(app, l1);
      const r0 = await a1.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({});
      expect(r0.status).toBe(422);
      expect(r0.body.message).toMatch(/batch/i);
      expect((await a1.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_id: am.id }).expect(200)).body).toMatchObject({ state: 'enrolled', batch_id: am.id });
      // The morning is full: the next booking queues for THAT batch, the afternoon still has a seat.
      const w = await (await signIn(app, l2)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_id: am.id }).expect(200);
      expect(w.body).toMatchObject({ state: 'waitlisted', position: 1, batch_id: am.id });
      await (await signIn(app, l3)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_id: pm.id }).expect(200);

      // Every view reads the same sittings.
      const cat = await a1.get('/api/learner/catalogue').expect(200);
      const entry = cat.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      const bySitting = Object.fromEntries(entry.sittings.map((x: { batch_id: number }) => [x.batch_id, x]));
      expect(bySitting[am.id]).toMatchObject({ capacity: 1, registered: 1, available: 0, is_full: true, waitlist: 1, start_time: '09:00' });
      expect(bySitting[pm.id]).toMatchObject({ registered: 1, available: 0 });
      expect(bySitting[span.id]).toMatchObject({ dates: ['2030-04-06', '2030-04-07', '2030-04-08'], available: 5, total_minutes: 540 });
      expect(entry).toMatchObject({ my_batch_id: am.id, seats_left: 5, capacity: 7 });
      const mine = await a1.get('/api/learner/sessions').expect(200);
      const ms = mine.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(ms.my_batch_id).toBe(am.id);
      expect(ms.sittings).toHaveLength(3);
      const admin = (await adminA.get('/api/admin/sessions').expect(200)).body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(admin.sittings.find((x: { batch_id: number }) => x.batch_id === am.id)).toMatchObject({ registered: 1, available: 0, waitlist: 1 });

      // Admin moves and adds respect each batch's capacity.
      const moved = await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: l3.id, batch_id: am.id });
      expect(moved.status).toBe(409);
      expect(moved.body.message).toMatch(/full \(1 of 1\)/);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: l4.id, batch_id: pm.id }).expect(409);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: l4.id, batch_id: span.id }).expect(200);
      expect((await dbQuery('SELECT batch_id FROM session_roster WHERE session_id = $1 AND user_id = $2', [s.id, l4.id]))[0].batch_id).toBe(span.id);
      // Capacity cannot drop below the people already placed.
      await adminA.put(`/api/admin/sessions/batches/${span.id}`).send({ label: 'Bootcamp', date: '2030-04-06', end_date: '2030-04-08', capacity: 2 }).expect(200);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: l2.id, batch_id: span.id }).expect(200);
      const low = await adminA.put(`/api/admin/sessions/batches/${span.id}`).send({ label: 'Bootcamp', date: '2030-04-06', capacity: 1 });
      expect(low.status).toBe(409);

      // Promotion goes into the queued batch, and only when it has room.
      const l5 = await person();
      await (await signIn(app, l5)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_id: pm.id }).expect(200);
      await adminA.post(`/api/admin/sessions/${s.id}/waitlist/${l5.id}/promote`).expect(409);
      await adminA.put(`/api/admin/sessions/batches/${pm.id}`).send({ label: 'Afternoon', date: '2030-04-01', start_time: '14:00', end_time: '17:00', capacity: 2 }).expect(200);
      await adminA.post(`/api/admin/sessions/${s.id}/waitlist/${l5.id}/promote`).expect(200);
      expect((await dbQuery('SELECT batch_id FROM session_roster WHERE session_id = $1 AND user_id = $2', [s.id, l5.id]))[0].batch_id).toBe(pm.id);

      // Cancelling frees the seat straight away.
      await a1.delete(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
      const after = (await a1.get('/api/learner/catalogue').expect(200)).body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(after.sittings.find((x: { batch_id: number }) => x.batch_id === am.id)).toMatchObject({ registered: 0, available: 1 });

      // Another org cannot book or see it.
      const learnerB = await signIn(app, fx.B.learner);
      await learnerB.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_id: am.id }).expect(404);
    });

    it('admin sees every learner\'s feedback and downloads the session report; another org gets 404', async () => {
      const [p1, p2] = [await person(), await person()];
      const s = await makeSession(adminA, fx.A, { date: '2030-05-01', end_date: '2030-05-02', start_time: '09:00', end_time: '12:00' });
      const b = (await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'Main', date: '2030-05-01', end_date: '2030-05-02', capacity: 5 }).expect(201)).body.batch;
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p1.id, batch_id: b.id }).expect(200);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p2.id }).expect(200);
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: p1.id, status: 'present' }, { user_id: p2.id, status: 'absent' }] }).expect((r) => expect(r.status).toBeLessThan(300));
      // Setup (not the subject): p1's feedback row, as the learner route writes it.
      await dbQuery(
        'INSERT INTO session_feedback (organization_id, session_id, user_id, rating_content, rating_trainer, rating_delivery, comment) VALUES ($1, $2, $3, 4, 5, 3, $4)',
        [fx.A.id, s.id, p1.id, 'Clear and practical'],
      );

      const fb = await adminA.get(`/api/admin/sessions/${s.id}/feedback`).expect(200);
      expect(fb.body.summary).toEqual({ count: 1, content: 4, trainer: 5, delivery: 3, overall: 4 });
      expect(fb.body.feedback).toEqual([expect.objectContaining({ userId: p1.id, email: p1.email, batch: 'Batch 1 · Main', average: 4, comment: 'Clear and practical' })]);
      expect(fb.body.feedback[0].submittedAt).toBeTruthy();

      const rep = await adminA.get(`/api/admin/sessions/${s.id}/report`).expect(200);
      expect(rep.body.session).toMatchObject({ title: s.body.title, firstDate: '2030-05-01', lastDate: '2030-05-02' });
      expect(rep.body.totals).toMatchObject({ learners: 2, batches: 1, capacity: 5, registered: 2, available: 4, feedbackCount: 1, scheduledMinutes: 360, attendanceRatePct: 50 });
      expect(rep.body.totals.attendance).toMatchObject({ present: 1, absent: 1 });
      expect(rep.body.learners.find((l: { email: string }) => l.email === p2.email).batch).toBe('Not placed in a batch');

      const x = await adminA.get(`/api/admin/sessions/${s.id}/report.xlsx`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(x.headers['content-type']).toMatch(/spreadsheetml/);
      expect(x.headers['content-disposition']).toMatch(/session-report-.*-2030-05-01\.xlsx/);
      const XLSX = await import('xlsx');
      const wb = XLSX.read(x.body as Buffer, { type: 'buffer' });
      expect(wb.SheetNames).toEqual(['Summary', 'Batches and schedule', 'Learners', 'Feedback']);
      const learners = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets.Learners);
      expect(learners.find((l) => l.Email === p1.email)).toMatchObject({ Batch: 'Batch 1 · Main', Attendance: 'Present', Comment: 'Clear and practical' });

      for (const path of ['feedback', 'report', 'report.xlsx']) {
        await adminB.get(`/api/admin/sessions/${s.id}/${path}`).expect(404);
        await learnerA.get(`/api/admin/sessions/${s.id}/${path}`).expect(403);
      }
    });
  });

  describe('attendance and completion', () => {
    it('the trainer sees and marks only their own sessions and cannot complete one', async () => {
      const other = await person('trainer');
      const mine = await makeSession(adminA, fx.A);
      const theirs = await makeSession(adminA, fx.A, { trainer_user_id: other.id });
      const p = await person();
      await adminA.post(`/api/admin/sessions/${mine.id}/roster`).send({ user_id: p.id }).expect(200);
      await adminA.post(`/api/admin/sessions/${theirs.id}/roster`).send({ user_id: p.id }).expect(200);

      const list = await trainerA.get('/api/trainer/sessions').expect(200);
      const ids = list.body.sessions.map((x: { id: number }) => Number(x.id));
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);

      const one = await trainerA.get(`/api/trainer/sessions/${mine.publicId}`).expect(200);
      expect(Number(one.body.session.id)).toBe(mine.id);
      await trainerA.get(`/api/trainer/sessions/${theirs.publicId}`).expect(404);

      const parts = await trainerA.get(`/api/trainer/sessions/${mine.publicId}/participants`).expect(200);
      expect(parts.body.participants.map((x: { user_id: number }) => x.user_id)).toEqual([p.id]);
      // No email addresses for the trainer.
      expect(JSON.stringify(parts.body)).not.toContain(p.email);
      await trainerA.get(`/api/trainer/sessions/${theirs.publicId}/participants`).expect(404);

      const marked = await trainerA.put(`/api/trainer/sessions/${mine.publicId}/attendance`).send({ records: [{ user_id: p.id, status: 'present' }] }).expect(200);
      expect(marked.body.participants[0]).toEqual(expect.objectContaining({ user_id: p.id, status: 'present', credits_training: true }));
      const [att] = await dbQuery('SELECT status, marked_by FROM session_attendance WHERE session_id = $1 AND user_id = $2', [mine.id, p.id]);
      expect(att).toEqual({ status: 'present', marked_by: fx.A.trainer.id });
      await trainerA.put(`/api/trainer/sessions/${theirs.publicId}/attendance`).send({ records: [{ user_id: p.id, status: 'present' }] }).expect(404);
      expect(await dbQuery('SELECT 1 FROM session_attendance WHERE session_id = $1', [theirs.id])).toHaveLength(0);

      // No complete route for a trainer, and the admin one refuses them.
      await trainerA.post(`/api/admin/sessions/${mine.id}/complete`).expect(403);
      expect((await dbQuery('SELECT status FROM sessions WHERE id = $1', [mine.id]))[0].status).toBe('upcoming');
      // A learner is not a trainer.
      await learnerA.get('/api/trainer/sessions').expect(403);
    });

    it('completion is refused with no attendance, then credits present, late and partial only', async () => {
      const s = await makeSession(adminA, fx.A, { start_time: '10:00', end_time: '11:00' });
      const people = await Promise.all(['present', 'late', 'partial', 'absent', 'excused'].map(() => person()));
      for (const p of people) await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);

      const refused = await adminA.post(`/api/admin/sessions/${s.id}/complete`);
      expect(refused.status).toBe(422);
      expect(refused.body.message).toMatch(/Mark attendance/);

      const statuses = ['present', 'late', 'partial', 'absent', 'excused'];
      await learnerA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [] }).expect(403);
      const saved = await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: people.map((p, i) => ({ user_id: p.id, status: statuses[i] })) }).expect(200);
      expect(saved.body.records.filter((r: { credits_training: boolean }) => r.credits_training)).toHaveLength(3);
      expect(saved.body.records[0].marker_name).toBe('AdminA Owner');
      const read = await adminA.get(`/api/admin/sessions/${s.id}/attendance`).expect(200);
      expect(read.body.records).toHaveLength(5);
      await adminB.get(`/api/admin/sessions/${s.id}/attendance`).expect(404);

      await learnerA.post(`/api/admin/sessions/${s.id}/complete`).expect(403);
      await adminB.post(`/api/admin/sessions/${s.id}/complete`).expect(404);
      const done = await adminA.post(`/api/admin/sessions/${s.id}/complete`).expect(200);
      expect(done.body.credited).toBe(3);
      expect(done.body.session.status).toBe('completed');

      const credited = await dbQuery(
        'SELECT c.user_id FROM user_lesson_completions c JOIN lessons l ON l.id = c.lesson_id WHERE l.course_id = $1', [s.trainingCourseId]);
      expect(credited.map((r) => r.user_id).sort()).toEqual(people.slice(0, 3).map((p) => p.id).sort());

      // Correcting attendance afterwards moves the credit both ways.
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: people[0].id, status: 'absent' }, { user_id: people[3].id, status: 'present' }] }).expect(200);
      const after = await dbQuery(
        'SELECT c.user_id FROM user_lesson_completions c JOIN lessons l ON l.id = c.lesson_id WHERE l.course_id = $1', [s.trainingCourseId]);
      expect(after.map((r) => r.user_id).sort()).toEqual([people[1].id, people[2].id, people[3].id].sort());
    });
  });

  describe('cancellation, archive and delete', () => {
    it('cancelling tells the roster and the trainer once, and a cancelled session cannot be completed', async () => {
      const p = await person();
      const s = await makeSession(adminA, fx.A);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: p.id, status: 'present' }] }).expect(200);

      await adminA.put(`/api/admin/sessions/${s.id}`).send({ ...s.body, status: 'cancelled' }).expect(200);
      await settle();
      expect(await notificationsOf(p.id, 'session_cancelled')).toHaveLength(1);
      const trainerNotes = (await notificationsOf(fx.A.trainer.id, 'session_cancelled')).filter((n) => `${n.title} ${n.body}`.includes(s.body.title));
      expect(trainerNotes).toHaveLength(1);

      // Saving again while cancelled does not re-announce.
      await adminA.put(`/api/admin/sessions/${s.id}`).send({ ...s.body, status: 'cancelled', venue_url: 'Room 2' }).expect(200);
      await settle();
      expect(await notificationsOf(p.id, 'session_cancelled')).toHaveLength(1);

      const r = await adminA.post(`/api/admin/sessions/${s.id}/complete`);
      expect(r.status).toBe(422);
    });

    it('bulk cancel, archive, restore and delete report what they affected', async () => {
      const p = await person();
      const s1 = await makeSession(adminA, fx.A);
      const s2 = await makeSession(adminA, fx.A);
      await adminA.post(`/api/admin/sessions/${s1.id}/roster`).send({ user_id: p.id }).expect(200);

      await learnerA.post('/api/admin/sessions/bulk').send({ ids: [s1.id], action: 'cancel' }).expect(403);
      const cancel = await adminA.post('/api/admin/sessions/bulk').send({ ids: [s1.id, s2.id], action: 'cancel' }).expect(200);
      expect(cancel.body).toEqual({ affected: 2, requested: 2, action: 'cancel' });
      await settle();
      expect(await notificationsOf(p.id, 'session_cancelled')).toHaveLength(1);
      // Already cancelled: nothing moves, nobody is told again.
      expect((await adminA.post('/api/admin/sessions/bulk').send({ ids: [s1.id], action: 'cancel' }).expect(200)).body.affected).toBe(0);

      // Another org's ids are simply not affected.
      expect((await adminB.post('/api/admin/sessions/bulk').send({ ids: [s1.id], action: 'archive' }).expect(200)).body.affected).toBe(0);

      expect((await adminA.post('/api/admin/sessions/bulk').send({ ids: [s1.id], action: 'archive' }).expect(200)).body.affected).toBe(1);
      const live = await adminA.get('/api/admin/sessions').expect(200);
      expect(live.body.sessions.map((x: { id: number }) => Number(x.id))).not.toContain(s1.id);
      const archived = await adminA.get('/api/admin/sessions').query({ archived: 'true' }).expect(200);
      expect(archived.body.sessions.map((x: { id: number }) => Number(x.id))).toContain(s1.id);
      expect((await adminA.post('/api/admin/sessions/bulk').send({ ids: [s1.id], action: 'restore' }).expect(200)).body.affected).toBe(1);

      const del = await adminA.post('/api/admin/sessions/bulk').send({ ids: [s1.id, 99999999], action: 'delete' }).expect(200);
      expect(del.body.requested).toBe(2);
      expect(await dbQuery('SELECT 1 FROM sessions WHERE id = $1', [s1.id])).toHaveLength(0);
      // The companion course and the assignment go with it.
      expect(await dbQuery('SELECT 1 FROM courses WHERE id = $1', [s1.trainingCourseId])).toHaveLength(0);
    });

    it('deletes one session; another org and a learner are refused', async () => {
      const s = await makeSession(adminA, fx.A);
      await learnerA.delete(`/api/admin/sessions/${s.id}`).expect(403);
      // Another org's delete changes nothing (its answer is pinned by the 404 test below).
      await adminB.delete(`/api/admin/sessions/${s.id}`);
      expect(await dbQuery('SELECT 1 FROM sessions WHERE id = $1', [s.id])).toHaveLength(1);
      const r = await adminA.delete(`/api/admin/sessions/${s.id}`).expect(200);
      expect(r.body.message).toBe('Session deleted');
      expect(await dbQuery('SELECT 1 FROM sessions WHERE id = $1', [s.id])).toHaveLength(0);
    });

    it('deleting another org\'s session answers 404 and deletes nothing', async () => {
      const s = await makeSession(adminA, fx.A);
      await adminB.delete(`/api/admin/sessions/${s.id}`).expect(404);
    });

    it('bulk delete does not count ids that do not exist or belong to another org', async () => {
      const s = await makeSession(adminA, fx.A);
      const r = await adminB.post('/api/admin/sessions/bulk').send({ ids: [s.id, 99999999], action: 'delete' }).expect(200);
      expect(r.body.affected).toBe(0);
    });
  });
});
