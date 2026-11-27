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
      expect(card).toEqual(expect.objectContaining({ enroll_mode: 'assigned', roster_count: 0, waitlist_count: 0, display_status: 'upcoming' }));
      // Every date has a batch (0076): a one-day session has one, following the session's times.
      expect(card.batches).toEqual([expect.objectContaining({ batch_no: 1, date: '2030-01-15', start_time: null, capacity: 10 })]);
      expect(card).toEqual(expect.objectContaining({ dates_text: '15th January 2030', rescheduled: false }));
      expect(card.schedule).toEqual([expect.objectContaining({ date: '2030-01-15', original_date: '2030-01-15', change: null })]);
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

    it('adds, edits and deletes day batches on a date and places people in them (0076)', async () => {
      const p = await person();
      const s = await makeSession(adminA, fx.A);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);
      const sched = await adminA.get(`/api/admin/sessions/${s.id}/schedule`).expect(200);
      expect(sched.body.dates).toHaveLength(1);
      const dateId = sched.body.dates[0].id;
      const b1id = sched.body.dates[0].batches[0].batch_id;
      // A date with one batch places everyone on the roster in it.
      expect(await dbQuery('SELECT batch_id FROM session_batch_members WHERE session_id = $1 AND user_id = $2', [s.id, p.id])).toEqual([{ batch_id: b1id }]);

      const b2 = await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ session_date_id: dateId, label: 'Afternoon', start_time: '14:00', end_time: '16:00', capacity: 5 }).expect(201);
      expect(b2.body.batch.batch_no ?? b2.body.batch.batchNo).toBe(2);
      const b2id = Number(b2.body.batch.id);
      await adminA.post(`/api/admin/sessions/${s.id}/batches`).send({ label: 'Nowhere' }).expect(422);
      await learnerA.post(`/api/admin/sessions/${s.id}/batches`).send({ session_date_id: dateId }).expect(403);
      await adminB.post(`/api/admin/sessions/${s.id}/batches`).send({ session_date_id: dateId }).expect(404);

      const up = await adminA.put(`/api/admin/sessions/batches/${b2id}`).send({ label: 'Late afternoon', start_time: '15:00', end_time: '17:00', capacity: 5 }).expect(200);
      expect(up.body.batch.label).toBe('Late afternoon');
      // The day belongs to the date, not the batch.
      expect((await adminA.put(`/api/admin/sessions/batches/${b2id}`).send({ label: 'x', date: '2030-01-20' })).status).toBe(422);
      await adminB.put(`/api/admin/sessions/batches/${b2id}`).send({ label: 'x' }).expect(404);

      await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: p.id, batch_id: b2id }).expect(200);
      expect(await dbQuery('SELECT batch_id FROM session_batch_members WHERE session_id = $1 AND user_id = $2', [s.id, p.id])).toEqual([{ batch_id: b2id }]);
      // Someone not on the roster cannot be placed.
      await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: fx.A.learner2.id, batch_id: b1id }).expect(404);
      // Taken off the date, with two batches there, they wait to be placed.
      await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: p.id, batch_id: null, session_date_id: dateId }).expect(200);
      expect(await dbQuery('SELECT 1 FROM session_batch_members WHERE session_id = $1 AND user_id = $2', [s.id, p.id])).toHaveLength(0);

      // Deleting a batch leaves one, so its date places everyone in it.
      const del = await adminA.delete(`/api/admin/sessions/batches/${b2id}`).expect(200);
      expect(del.body.message).toMatch(/stay on the session/);
      expect(await dbQuery('SELECT batch_id FROM session_batch_members WHERE session_id = $1 AND user_id = $2', [s.id, p.id])).toEqual([{ batch_id: b1id }]);
      // The last batch on a date goes with the date, not on its own.
      expect((await adminA.delete(`/api/admin/sessions/batches/${b1id}`)).status).toBe(422);
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
    it('a start-to-end range becomes one date each, credits every day, and an end before the start is refused', async () => {
      const s = await makeSession(adminA, fx.A, { date: '2030-03-02', end_date: '2030-03-04', start_time: '09:00', end_time: '11:00' });
      const [lesson] = await dbQuery('SELECT duration_minutes FROM lessons WHERE course_id = $1', [s.trainingCourseId]);
      expect(Number(lesson.duration_minutes)).toBe(360);
      const list = await adminA.get('/api/admin/sessions').expect(200);
      const card = list.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(card.sittings.map((x: { dates: string[] }) => x.dates)).toEqual([['2030-03-02'], ['2030-03-03'], ['2030-03-04']]);
      expect(card.sittings[0]).toMatchObject({ start_time: '09:00', total_minutes: 120 });
      expect(card.dates_text).toBe('2nd, 3rd, 4th March 2030');
      const bad = await adminA.post('/api/admin/sessions').send(sessionBody(fx.A, { date: '2030-03-05', end_date: '2030-03-01' }));
      expect(bad.status).toBe(400);
      expect(bad.body.message).toMatch(/end date/i);
    });

    it('creates on chosen dates with time slots; each date and slot is a batch with its own seats; a learner books one per date; no overbooking (0076)', async () => {
      const [l1, l2, l3, l4] = [await person(), await person(), await person(), await person()];
      const s = await makeSession(adminA, fx.A, {
        enroll_mode: 'self', capacity: 10, date: '2030-04-01', start_time: '09:00', end_time: '12:00',
        dates: ['2030-04-01', '2030-05-02'],
        slots: [{ label: 'Morning', start_time: '09:00', end_time: '12:00', capacity: 1 }, { label: 'Afternoon', start_time: '14:00', end_time: '17:00', capacity: 1 }],
      });
      const sched = (await adminA.get(`/api/admin/sessions/${s.id}/schedule`).expect(200)).body;
      expect(sched.dates.map((d: { date: string }) => d.date)).toEqual(['2030-04-01', '2030-05-02']);
      expect(sched.dates_text).toBe('1st April and 2nd May 2030');
      const [d1, d2] = sched.dates;
      const am1 = d1.batches.find((b: { label: string }) => b.label === 'Morning');
      const pm1 = d1.batches.find((b: { label: string }) => b.label === 'Afternoon');
      const am2 = d2.batches.find((b: { label: string }) => b.label === 'Morning');
      const pm2 = d2.batches.find((b: { label: string }) => b.label === 'Afternoon');
      expect(am1).toMatchObject({ name: 'Batch 1 · Morning', capacity: 1, start_time: '09:00', dates: ['2030-04-01'] });
      expect(pm2).toMatchObject({ name: 'Batch 2 · Afternoon', start_time: '14:00', dates: ['2030-05-02'] });
      // Duration is the session's day times the number of dates.
      const [lesson] = await dbQuery('SELECT duration_minutes FROM lessons WHERE course_id = $1', [s.trainingCourseId]);
      expect(Number(lesson.duration_minutes)).toBe(360);

      const a1 = await signIn(app, l1);
      const r0 = await a1.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({});
      expect(r0.status).toBe(422);
      expect(r0.body.message).toMatch(/batch/i);
      const r1 = await a1.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_ids: [am1.batch_id] });
      expect(r1.status).toBe(422);
      expect(r1.body.message).toMatch(/2 May 2030/);
      expect((await a1.post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_ids: [am1.batch_id, am2.batch_id] }).expect(200)).body)
        .toMatchObject({ state: 'enrolled', batch_ids: [am1.batch_id, am2.batch_id] });
      // The first morning is full: the next booking that wants it queues for THAT batch.
      const w = await (await signIn(app, l2)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_ids: [am1.batch_id, pm2.batch_id] }).expect(200);
      expect(w.body).toMatchObject({ state: 'waitlisted', position: 1, batch_id: am1.batch_id });
      await (await signIn(app, l3)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_ids: [pm1.batch_id, pm2.batch_id] }).expect(200);

      // Every view reads the same sittings; places are the tightest date's.
      const cat = await a1.get('/api/learner/catalogue').expect(200);
      const entry = cat.body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      const bySitting = Object.fromEntries(entry.sittings.map((x: { batch_id: number }) => [x.batch_id, x]));
      expect(bySitting[am1.batch_id]).toMatchObject({ capacity: 1, registered: 1, available: 0, is_full: true, waitlist: 1 });
      expect(bySitting[am2.batch_id]).toMatchObject({ registered: 1, available: 0 });
      expect(entry).toMatchObject({ my_batch_id: am1.batch_id, seats_left: 0, capacity: 2, is_full: true, dates_text: '1st April and 2nd May 2030' });
      const mine = (await a1.get('/api/learner/sessions').expect(200)).body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect([...mine.my_batch_ids].sort()).toEqual([am1.batch_id, am2.batch_id].sort());
      expect(mine.sittings).toHaveLength(4);
      expect(mine.schedule.map((d: { date: string }) => d.date)).toEqual(['2030-04-01', '2030-05-02']);

      // Admin placements respect each batch's capacity.
      const moved = await adminA.put(`/api/admin/sessions/${s.id}/roster/batch`).send({ user_id: l3.id, batch_id: am1.batch_id });
      expect(moved.status).toBe(409);
      expect(moved.body.message).toMatch(/full \(1 of 1\)/);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: l4.id, batch_id: pm1.batch_id }).expect(409);
      await adminA.put(`/api/admin/sessions/batches/${pm1.batch_id}`).send({ label: 'Afternoon', start_time: '14:00', end_time: '17:00', capacity: 2 }).expect(200);
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: l4.id, batch_id: pm1.batch_id }).expect(200);
      // Placed on the date they were added to; the other date offers a choice, so it waits.
      expect(await dbQuery('SELECT batch_id FROM session_batch_members WHERE session_id = $1 AND user_id = $2', [s.id, l4.id])).toEqual([{ batch_id: pm1.batch_id }]);
      const low = await adminA.put(`/api/admin/sessions/batches/${pm1.batch_id}`).send({ label: 'Afternoon', capacity: 1 });
      expect(low.status).toBe(409);

      // Promotion goes into the queued batch, and only when it has room.
      await adminA.post(`/api/admin/sessions/${s.id}/waitlist/${l2.id}/promote`).expect(409);
      await adminA.put(`/api/admin/sessions/batches/${am1.batch_id}`).send({ label: 'Morning', start_time: '09:00', end_time: '12:00', capacity: 2 }).expect(200);
      await adminA.post(`/api/admin/sessions/${s.id}/waitlist/${l2.id}/promote`).expect(200);
      expect(await dbQuery('SELECT batch_id FROM session_batch_members WHERE session_id = $1 AND user_id = $2', [s.id, l2.id])).toEqual([{ batch_id: am1.batch_id }]);

      // Cancelling frees every seat straight away.
      await a1.delete(`/api/learner/catalogue/sessions/${s.id}/enrol`).expect(200);
      const after = (await a1.get('/api/learner/catalogue').expect(200)).body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(after.sittings.find((x: { batch_id: number }) => x.batch_id === am2.batch_id)).toMatchObject({ registered: 0, available: 1 });

      // Another org cannot book or read it.
      await (await signIn(app, fx.B.learner)).post(`/api/learner/catalogue/sessions/${s.id}/enrol`).send({ batch_ids: [am1.batch_id] }).expect(404);
      await adminB.get(`/api/admin/sessions/${s.id}/schedule`).expect(404);
    });

    it('moving a date keeps its batches, places and attendance, labels it postponed or preponed, and tells the roster and trainer (0076)', async () => {
      const p = await person();
      const s = await makeSession(adminA, fx.A, { date: '2030-06-02', end_date: '2030-06-04', start_time: '09:00', end_time: '12:00' });
      await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);
      const before = (await adminA.get(`/api/admin/sessions/${s.id}/schedule`).expect(200)).body.dates;
      const [d1, d2] = before;
      const batchOnD2 = d2.batches[0].batch_id;

      // Attendance per date rolls up: present on one of three is partial.
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ session_date_id: d1.id, records: [{ user_id: p.id, status: 'present' }] }).expect(200);
      const att = (await adminA.get(`/api/admin/sessions/${s.id}/attendance`).expect(200)).body;
      const rec = att.records.find((r: { user_id: number }) => r.user_id === p.id);
      expect(rec.status).toBe('partial');
      expect(rec.days.map((x: { status: string | null }) => x.status)).toEqual(['present', null, null]);
      expect(att.dates.map((x: { date: string }) => x.date)).toEqual(['2030-06-02', '2030-06-03', '2030-06-04']);
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ session_date_id: 999999, records: [] }).expect(404);

      // Postpone the second date by a week.
      const moved = await adminA.put(`/api/admin/sessions/dates/${d2.id}`).send({ date: '2030-06-10' }).expect(200);
      expect(moved.body.changes.moves).toEqual([{ from: '2030-06-03', to: '2030-06-10', change: 'postponed' }]);
      const d2now = moved.body.dates.find((d: { id: number }) => d.id === d2.id);
      expect(d2now).toMatchObject({ date: '2030-06-10', previous_date: '2030-06-03', original_date: '2030-06-03', change: 'postponed' });
      expect(d2now.batches[0]).toMatchObject({ batch_id: batchOnD2, dates: ['2030-06-10'] });
      expect(await dbQuery('SELECT 1 FROM session_batch_members WHERE batch_id = $1 AND user_id = $2', [batchOnD2, p.id])).toHaveLength(1);
      await settle();
      const [note] = await notificationsOf(p.id, 'session_rescheduled');
      expect(note.title).toBe(`Postponed: ${s.body.title}`);
      expect((await notificationsOf(fx.A.trainer.id, 'session_rescheduled')).some((n) => n.title === `Postponed: ${s.body.title}`)).toBe(true);
      const [mail] = await dbQuery<{ facts: string }>(`SELECT facts::text AS facts FROM email_outbox WHERE user_id = $1 AND type = 'session_rescheduled' ORDER BY id DESC LIMIT 1`, [p.id]);
      expect(mail.facts).toMatch(/3 Jun 2030 moved to 10 Jun 2030/);

      // The learner and the trainer see the new date and the label.
      const mine = (await (await signIn(app, p)).get('/api/learner/sessions').expect(200)).body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(mine.schedule.find((d: { date: string }) => d.date === '2030-06-10').change).toBe('postponed');
      expect(mine.rescheduled).toBe(true);
      const tr = (await trainerA.get('/api/trainer/sessions').expect(200)).body.sessions.find((x: { id: number }) => Number(x.id) === s.id);
      expect(tr.dates_text).toBe('2nd, 4th, 10th June 2030');

      // The whole set at once: 4 Jun replaced by 1 Jun is a move, preponed.
      const set = await adminA.put(`/api/admin/sessions/${s.id}/schedule`).send({ dates: ['2030-06-01', '2030-06-02', '2030-06-10'] }).expect(200);
      expect(set.body.changes.moves).toEqual([{ from: '2030-06-04', to: '2030-06-01', change: 'preponed' }]);
      expect(set.body.dates_text).toBe('1st, 2nd, 10th June 2030');
      // A date with attendance marked cannot be removed.
      const blocked = await adminA.put(`/api/admin/sessions/${s.id}/schedule`).send({ dates: ['2030-06-01', '2030-06-10'] });
      expect(blocked.status).toBe(409);
      expect(blocked.body.message).toMatch(/2 Jun 2030/);
      // Add a date (it copies a neighbour's batches), then delete it.
      const added = await adminA.post(`/api/admin/sessions/${s.id}/dates`).send({ date: '2030-06-20' }).expect(201);
      const extra = added.body.dates.find((d: { date: string }) => d.date === '2030-06-20');
      expect(extra.batches).toHaveLength(1);
      await adminA.post(`/api/admin/sessions/${s.id}/dates`).send({ date: '2030-06-20' }).expect(409);
      await adminA.delete(`/api/admin/sessions/dates/${extra.id}`).expect(200);
      const [lesson] = await dbQuery('SELECT duration_minutes FROM lessons WHERE course_id = $1', [s.trainingCourseId]);
      expect(Number(lesson.duration_minutes)).toBe(540);

      await learnerA.put(`/api/admin/sessions/${s.id}/schedule`).send({ dates: ['2030-06-01'] }).expect(403);
      await adminB.put(`/api/admin/sessions/${s.id}/schedule`).send({ dates: ['2030-06-01'] }).expect(404);
      await adminB.put(`/api/admin/sessions/dates/${d1.id}`).send({ date: '2030-07-01' }).expect(404);
      await adminB.delete(`/api/admin/sessions/dates/${d1.id}`).expect(404);
      await adminB.post(`/api/admin/sessions/${s.id}/dates`).send({ date: '2030-07-01' }).expect(404);
      await adminA.put(`/api/admin/sessions/${s.id}/schedule`).send({ dates: ['not-a-date'] }).expect(400);

      // Marking every date (no date named) makes them present overall; the
      // certificate lists every date the training ran on.
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: p.id, status: 'present' }] }).expect(200);
      expect((await dbQuery('SELECT status FROM session_attendance WHERE session_id = $1 AND user_id = $2', [s.id, p.id]))[0].status).toBe('present');
      await adminA.post(`/api/admin/sessions/${s.id}/complete`).expect(200);
      const [held] = await dbQuery('SELECT id FROM certificates WHERE course_id = $1 AND user_id = $2', [s.trainingCourseId, p.id]);
      const cert = (await (await signIn(app, p)).get(`/api/learner/certificates/${held.id}`).expect(200)).body.certificate;
      expect(cert.session).toMatchObject({ dates: ['2030-06-01', '2030-06-02', '2030-06-10'], dates_text: '1st, 2nd, 10th June 2030' });
      // A completed session's dates no longer move.
      expect((await adminA.put(`/api/admin/sessions/dates/${d1.id}`).send({ date: '2030-06-05' })).status).toBe(422);
    });

    it('admin sees every learner\'s feedback and downloads the session report; another org gets 404', async () => {
      const [p1, p2] = [await person(), await person()];
      const s = await makeSession(adminA, fx.A, { date: '2030-05-01', end_date: '2030-05-02', start_time: '09:00', end_time: '12:00' });
      // A 'Main' batch beside the default one on each of the two dates.
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
      expect(fb.body.feedback).toEqual([expect.objectContaining({ userId: p1.id, email: p1.email, batch: 'Batch 2 · Main (1 May)', average: 4, comment: 'Clear and practical' })]);
      expect(fb.body.feedback[0].submittedAt).toBeTruthy();

      const rep = await adminA.get(`/api/admin/sessions/${s.id}/report`).expect(200);
      expect(rep.body.session).toMatchObject({ title: s.body.title, firstDate: '2030-05-01', lastDate: '2030-05-02' });
      expect(rep.body.totals).toMatchObject({ learners: 2, batches: 4, registered: 2, feedbackCount: 1, scheduledMinutes: 360, attendanceRatePct: 50 });
      expect(rep.body.session).toMatchObject({ dates_text: '1st, 2nd May 2030' });
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
      expect(learners.find((l) => l.Email === p1.email)).toMatchObject({ Batch: 'Batch 2 · Main (1 May)', Attendance: 'Present', Comment: 'Clear and practical' });

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

    it('completing issues one session certificate per attendee, notifies and emails each once, and logs it (§10.66)', async () => {
      const s = await makeSession(adminA, fx.A, { start_time: '09:00', end_time: '10:00' });
      const people = await Promise.all(['present', 'late', 'partial', 'absent'].map(() => person()));
      for (const p of people) await adminA.post(`/api/admin/sessions/${s.id}/roster`).send({ user_id: p.id }).expect(200);
      const statuses = ['present', 'late', 'partial', 'absent'];
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: people.map((p, i) => ({ user_id: p.id, status: statuses[i] })) }).expect(200);

      const done = await adminA.post(`/api/admin/sessions/${s.id}/complete`).expect(200);
      expect(done.body.certificatesIssued).toBe(3);
      expect(done.body.message).toMatch(/3 certificates issued and emailed/);
      await settle();

      const certs = await dbQuery('SELECT id, user_id, certificate_code FROM certificates WHERE course_id = $1 ORDER BY user_id', [s.trainingCourseId]);
      expect(certs.map((c) => c.user_id).sort()).toEqual(people.slice(0, 3).map((p) => p.id).sort());

      // Each attendee: one in-app notification and one email, about THEIR certificate.
      for (const p of people.slice(0, 3)) {
        const mine = certs.find((c) => c.user_id === p.id);
        const notes = await dbQuery("SELECT subject_id, title FROM notifications WHERE user_id = $1 AND type = 'certificate_issued'", [p.id]);
        expect(notes).toHaveLength(1);
        expect(notes[0].subject_id).toBe(mine.id);
        expect(notes[0].title).toMatch(/^Session completed:/);
        const mail = await dbQuery("SELECT facts::text AS facts FROM email_outbox WHERE user_id = $1 AND type = 'certificate_issued'", [p.id]);
        expect(mail).toHaveLength(1);
        expect(mail[0].facts).toContain(mine.certificate_code);
      }
      expect(await notificationsOf(people[3].id, 'certificate_issued')).toHaveLength(0);

      // The learner finds it in their own certificates.
      const learner = await signIn(app, people[0]);
      const list = await learner.get('/api/learner/certificates').expect(200);
      const own = list.body.certificates.find((c: { id: number }) => c.id === certs.find((x) => x.user_id === people[0].id).id);
      expect(own).toEqual(expect.objectContaining({ kind: 'session', isRevoked: false }));

      // Never twice: re-saving as completed and correcting attendance re-sync, but issue nothing new.
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: people[1].id, status: 'present' }] }).expect(200);
      const again = await adminA.post(`/api/admin/sessions/${s.id}/complete`).expect(200);
      expect(again.body.certificatesIssued).toBe(0);
      await settle();
      expect(await dbQuery('SELECT id FROM certificates WHERE course_id = $1', [s.trainingCourseId])).toHaveLength(3);
      expect(await notificationsOf(people[0].id, 'certificate_issued')).toHaveLength(1);

      // A late correction to "present" earns the certificate then, once.
      await adminA.put(`/api/admin/sessions/${s.id}/attendance`).send({ records: [{ user_id: people[3].id, status: 'present' }] }).expect(200);
      await settle();
      expect(await dbQuery('SELECT id FROM certificates WHERE course_id = $1', [s.trainingCourseId])).toHaveLength(4);

      // The admin's log: certificate, notification and email status per attendee.
      const log = await adminA.get(`/api/admin/sessions/${s.id}/certificates`).expect(200);
      expect(log.body.learners).toHaveLength(4);
      const row = log.body.learners.find((l: { userId: number }) => l.userId === people[0].id);
      expect(row).toEqual(expect.objectContaining({ attendance: 'present', eligible: true, emailStatus: expect.any(String) }));
      expect(row.certificate).toEqual(expect.objectContaining({ code: certs.find((c) => c.user_id === people[0].id).certificate_code, revoked: false }));
      expect(row.notifiedAt).toEqual(expect.any(String));
      await learnerA.get(`/api/admin/sessions/${s.id}/certificates`).expect(403);
      await adminB.get(`/api/admin/sessions/${s.id}/certificates`).expect(404);

      // Activity log entry for the admin.
      const act = await dbQuery("SELECT detail FROM activity_log WHERE organization_id = $1 AND type = 'certificate_issued' AND subject_type = 'session' AND subject_id = $2 ORDER BY id", [fx.A.id, s.id]);
      expect(act.length).toBeGreaterThanOrEqual(1);
      expect(act[0].detail).toMatch(/Issued 3 session certificates/);
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
