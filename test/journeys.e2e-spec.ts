/**
 * Learning paths (CONTEXT.md §5, §6, §18.4): build, steps (and Undeliverable
 * steps refused), assign, the Path gate on every way into a Course, Direct
 * assignment opening a step, path completion, unassign, bulk actions.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent, type Person } from './helpers';
import { assignCourse, completeCourse, makeCourse, makeSession, notificationsOf, settle, type CourseFx } from './support/3';

describe('learning paths', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  const made: number[] = [];

  const person = async (extra: Record<string, unknown> = {}): Promise<Person> => {
    const p = await newPerson(adminA, fx.A, 'learner', extra);
    made.push(p.id);
    return p;
  };

  /** A path of `n` one-lesson courses, steps required unless listed in `optional`. */
  const makePath = async (n: number, optional: number[] = []) => {
    const courses: CourseFx[] = [];
    for (let i = 0; i < n; i++) courses.push(await makeCourse(adminA, { lessons: 1 }));
    const title = uniq('Path');
    const j = await adminA.post('/api/admin/journeys').send({ title, badge_label: 'Pathfinder', points_bonus: 250 }).expect(201);
    const id = Number(j.body.journey.id);
    await adminA.put(`/api/admin/journeys/${id}/courses`).send({ courses: courses.map((c, i) => ({ course_id: c.id, is_required: !optional.includes(i) })) }).expect(200);
    return { id, title, courses };
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

  describe('building', () => {
    it('creates, reads, updates and lists a path; another org gets 404; a learner 403', async () => {
      const title = uniq('Path');
      await learnerA.post('/api/admin/journeys').send({ title, badge_label: 'x' }).expect(403);
      const c = await adminA.post('/api/admin/journeys').send({ title, badge_label: 'Explorer', tag: 'Leadership' }).expect(201);
      expect(c.body.journey).toEqual(expect.objectContaining({ title, badge_label: 'Explorer', points_bonus: 200, is_active: true }));
      const id = Number(c.body.journey.id);

      const got = await adminA.get(`/api/admin/journeys/${id}`).expect(200);
      expect(got.body.journey.title).toBe(title);
      await adminB.get(`/api/admin/journeys/${id}`).expect(404);

      const put = await adminA.put(`/api/admin/journeys/${id}`).send({ title: `${title} v2`, badge_label: 'Explorer', points_bonus: 300 }).expect(200);
      expect(put.body.journey).toEqual(expect.objectContaining({ title: `${title} v2`, points_bonus: 300 }));
      await adminB.put(`/api/admin/journeys/${id}`).send({ title: 'hijack', badge_label: 'x' }).expect(404);
      await learnerA.put(`/api/admin/journeys/${id}`).send({ title: 'hijack', badge_label: 'x' }).expect(403);

      const list = await adminA.get('/api/admin/journeys').expect(200);
      expect(list.body.journeys.map((j: { id: number }) => Number(j.id))).toContain(id);
      expect((await adminB.get('/api/admin/journeys').expect(200)).body.journeys.map((j: { id: number }) => Number(j.id))).not.toContain(id);
      await learnerA.get('/api/admin/journeys').expect(403);
    });

    it('sets ordered steps, and refuses a duplicate, another org\'s course and an undeliverable step by name', async () => {
      const a = await makeCourse(adminA);
      const b = await makeCourse(adminA);
      const j = await adminA.post('/api/admin/journeys').send({ title: uniq('Path'), badge_label: 'x' }).expect(201);
      const id = Number(j.body.journey.id);

      const set = await adminA.put(`/api/admin/journeys/${id}/courses`).send({ courses: [{ course_id: b.id }, { course_id: a.id, is_required: false }] }).expect(200);
      expect(set.body.courses.map((c: { course_id: number; is_required: boolean }) => [c.course_id, c.is_required])).toEqual([[b.id, true], [a.id, false]]);

      await adminA.put(`/api/admin/journeys/${id}/courses`).send({ courses: [{ course_id: a.id }, { course_id: a.id }] }).expect(422);
      const bCourse = await makeCourse(adminB);
      await adminA.put(`/api/admin/journeys/${id}/courses`).send({ courses: [{ course_id: a.id }, { course_id: bCourse.id }] }).expect(404);
      // A path of one course is just a course assignment.
      await adminA.put(`/api/admin/journeys/${id}/courses`).send({ courses: [{ course_id: a.id }] }).expect(400);
      await learnerA.put(`/api/admin/journeys/${id}/courses`).send({ courses: [{ course_id: a.id }, { course_id: b.id }] }).expect(403);

      const s = await makeSession(adminA, fx.A);
      const bad = await adminA.put(`/api/admin/journeys/${id}/courses`).send({ courses: [{ course_id: a.id }, { course_id: s.trainingCourseId }] });
      expect(bad.status).toBe(422);
      expect(bad.body.message).toContain(s.body.title);
      // Refused whole: the steps are unchanged.
      expect((await adminA.get(`/api/admin/journeys/${id}`)).body.journey.courses.map((c: { course_id: number }) => c.course_id)).toEqual([b.id, a.id]);
    });
  });

  describe('assigning and the path gate', () => {
    it('assigns by people, notifies only the newly added, and locks later steps on every way in', async () => {
      const path = await makePath(2);
      const p = await person();
      await learnerA.post(`/api/admin/journeys/${path.id}/assign`).send({ user_ids: [p.id] }).expect(403);
      await adminA.post(`/api/admin/journeys/${path.id}/assign`).send({}).expect(422);

      const r = await adminA.post(`/api/admin/journeys/${path.id}/assign`).send({ user_ids: [p.id] }).expect((x) => expect(x.status).toBeLessThan(300));
      expect(r.body).toEqual({ assigned: 1, skipped: 0 });
      const again = await adminA.post(`/api/admin/journeys/${path.id}/assign`).send({ user_ids: [p.id] });
      expect(again.body).toEqual({ assigned: 0, skipped: 1 });
      await settle();
      expect(await notificationsOf(p.id, 'journey_assigned')).toHaveLength(1);

      const asg = await dbQuery('SELECT course_id, source_journey_id FROM user_course_assignments WHERE user_id = $1 ORDER BY course_id', [p.id]);
      expect(asg).toEqual(path.courses.map((c) => ({ course_id: c.id, source_journey_id: path.id })));

      const me = await signIn(app, p);
      const detail = await me.get(`/api/learner/journeys/${path.id}`).expect(200);
      expect(detail.body.journey.courses.map((c: { status: string }) => c.status)).toEqual(['open', 'locked']);

      // Step 2 is locked for the lesson read and the completion write.
      const locked = path.courses[1].lessonIds[0];
      await me.get(`/api/learner/lessons/${locked}`).expect(403);
      await me.post(`/api/learner/lessons/${locked}/complete`).expect(403);
      expect(await dbQuery('SELECT 1 FROM user_lesson_completions WHERE user_id = $1 AND lesson_id = $2', [p.id, locked])).toHaveLength(0);

      // Finishing step 1 opens step 2.
      await completeCourse(me, path.courses[0]);
      const after = await me.get(`/api/learner/journeys/${path.id}`).expect(200);
      expect(after.body.journey.courses.map((c: { status: string }) => c.status)).toEqual(['complete', 'open']);
      await me.get(`/api/learner/lessons/${locked}`).expect(200);

      const learners = await adminA.get(`/api/admin/journeys/${path.id}/learners`).expect(200);
      expect(learners.body.learners.map((l: { user_id: number; id: number }) => l.user_id ?? l.id)).toContain(p.id);
      await adminB.get(`/api/admin/journeys/${path.id}/learners`).expect(404);
    });

    it('a direct assignment of a later step opens it, and the path never takes it away', async () => {
      const path = await makePath(2);
      const p = await person();
      await assignCourse(adminA, path.courses[1].id, [p.id]);
      await adminA.post(`/api/admin/journeys/${path.id}/assign`).send({ user_ids: [p.id] }).expect((x) => expect(x.status).toBeLessThan(300));

      const [row] = await dbQuery('SELECT source_journey_id FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, path.courses[1].id]);
      expect(row.source_journey_id).toBeNull();
      const me = await signIn(app, p);
      const d = await me.get(`/api/learner/journeys/${path.id}`).expect(200);
      expect(d.body.journey.courses[1].status).toBe('open');
      await me.get(`/api/learner/lessons/${path.courses[1].lessonIds[0]}`).expect(200);

      // Unassigning the path removes only the assignments it created.
      await learnerA.delete(`/api/admin/journeys/${path.id}/assign/${p.id}`).expect(403);
      await adminA.delete(`/api/admin/journeys/${path.id}/assign/${p.id}`).expect(200);
      const left = await dbQuery('SELECT course_id FROM user_course_assignments WHERE user_id = $1', [p.id]);
      expect(left.map((x) => x.course_id)).toEqual([path.courses[1].id]);
      await me.get(`/api/learner/journeys/${path.id}`).expect(404);
      await adminA.delete(`/api/admin/journeys/${path.id}/assign/${p.id}`).expect(404);
    });

    it('assigning by department reaches only that department; another org\'s people are skipped', async () => {
      const path = await makePath(2);
      const dept = uniq('PathDept');
      const a = await person({ department: dept });
      const r = await adminA.post(`/api/admin/journeys/${path.id}/assign`).send({ department: dept }).expect((x) => expect(x.status).toBeLessThan(300));
      expect(r.body.assigned).toBe(1);
      expect(await dbQuery('SELECT user_id FROM journey_enrollments WHERE journey_id = $1', [path.id])).toEqual([{ user_id: a.id }]);
      const cross = await adminA.post(`/api/admin/journeys/${path.id}/assign`).send({ user_ids: [fx.B.learner.id] });
      expect(cross.body).toEqual({ assigned: 0, skipped: 0 });
      await adminB.post(`/api/admin/journeys/${path.id}/assign`).send({ user_ids: [fx.B.learner.id] }).expect(404);
    });
  });

  describe('completing a path', () => {
    it('finishing every required step stamps the path complete and awards the path badge; optional steps do not block', async () => {
      const path = await makePath(3, [2]);
      const p = await person();
      await adminA.post(`/api/admin/journeys/${path.id}/assign`).send({ user_ids: [p.id] }).expect((x) => expect(x.status).toBeLessThan(300));
      const me = await signIn(app, p);

      const list = await me.get('/api/learner/journeys').expect(200);
      const card = list.body.journeys.find((j: { id: number }) => Number(j.id) === path.id);
      expect(card).toBeDefined();

      await completeCourse(me, path.courses[0]);
      expect((await dbQuery('SELECT completed_at FROM journey_enrollments WHERE journey_id = $1 AND user_id = $2', [path.id, p.id]))[0].completed_at).toBeNull();
      await completeCourse(me, path.courses[1]);

      const [en] = await dbQuery('SELECT completed_at FROM journey_enrollments WHERE journey_id = $1 AND user_id = $2', [path.id, p.id]);
      expect(en.completed_at).not.toBeNull();
      const badges = await dbQuery('SELECT badge_key FROM user_badges WHERE user_id = $1 AND journey_id = $2', [p.id, path.id]);
      expect(badges.map((b) => b.badge_key)).toContain(`journey:${path.id}`);
      // The path Certificate is not asserted: it needs certificates.course_id nullable,
      // which scripts/migrate-journey-certificates.mjs does outside the boot migrations,
      // so the e2e database cannot hold one (issueForJourney is best effort and logs it).

      const d = await me.get(`/api/learner/journeys/${path.id}`).expect(200);
      expect(d.body.journey).toEqual(expect.objectContaining({ percent: 100, status: 'complete', completed_count: 2, not_started_count: 1 }));
      expect(d.body.journey.completed_at).toBeTruthy();
      // Another learner cannot read a path they are not on.
      await learnerA.get(`/api/learner/journeys/${path.id}`).expect(404);
      await adminA.get('/api/learner/journeys').expect(403);
    });
  });

  describe('bulk and delete', () => {
    it('drafts, activates, archives, restores and deletes; another org affects nothing', async () => {
      const a = await adminA.post('/api/admin/journeys').send({ title: uniq('Path'), badge_label: 'x' }).expect(201);
      const id = Number(a.body.journey.id);
      await learnerA.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'draft' }).expect(403);
      expect((await adminB.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'archive' }).expect(200)).body.affected).toBe(0);

      expect((await adminA.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'draft' }).expect(200)).body).toEqual({ affected: 1, requested: 1, action: 'draft' });
      expect((await dbQuery('SELECT is_active FROM journeys WHERE id = $1', [id]))[0].is_active).toBe(0);
      expect((await adminA.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'archive' }).expect(200)).body.affected).toBe(1);
      // An archived path cannot be published.
      expect((await adminA.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'activate' }).expect(200)).body.affected).toBe(0);
      const archived = await adminA.get('/api/admin/journeys').query({ archived: true }).expect(200);
      expect(archived.body.journeys.map((j: { id: number }) => Number(j.id))).toContain(id);
      expect((await adminA.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'restore' }).expect(200)).body.affected).toBe(1);
      expect((await adminA.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'activate' }).expect(200)).body.affected).toBe(1);
      expect((await adminA.post('/api/admin/journeys/bulk').send({ ids: [id], action: 'delete' }).expect(200)).body.affected).toBe(1);
      expect(await dbQuery('SELECT 1 FROM journeys WHERE id = $1', [id])).toHaveLength(0);
    });

    it('deletes one path; another org and a learner are refused', async () => {
      const a = await adminA.post('/api/admin/journeys').send({ title: uniq('Path'), badge_label: 'x' }).expect(201);
      const id = Number(a.body.journey.id);
      await adminB.delete(`/api/admin/journeys/${id}`).expect(404);
      await learnerA.delete(`/api/admin/journeys/${id}`).expect(403);
      await adminA.delete(`/api/admin/journeys/${id}`).expect(200);
      expect(await dbQuery('SELECT 1 FROM journeys WHERE id = $1', [id])).toHaveLength(0);
      await adminA.get(`/api/admin/journeys/${id}`).expect(404);
    });
  });
});
