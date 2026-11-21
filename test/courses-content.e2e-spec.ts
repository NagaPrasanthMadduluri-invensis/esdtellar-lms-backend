/**
 * Content (CONTEXT.md §5, §7): courses, the Course Library and bulk actions,
 * modules (reorder), lessons incl. staged lessons, resources, assignments,
 * the learner's course read, lesson completion and what course completion
 * triggers (certificate, notification, points).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent, type Person } from './helpers';
import { assign, buildCourse, eventually, limitedAdmin, notificationsOf, ok } from './support/2';

describe('courses and content', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let learnerB: Agent;
  let viewer: Agent; // admin portal, no manage_courses / assign_learning

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    learnerB = await signIn(app, fx.B.learner);
    viewer = (await limitedAdmin(app, adminA, fx.A, ['view_dashboard'])).agent;
  });
  afterAll(async () => { await app.close(); });

  describe('course lifecycle', () => {
    it('creates a published course by default; compliance is mandatory with a renewal period', async () => {
      const name = uniq('Compliance');
      const r = await adminA.post('/api/admin/courses').send({ name, category: 'Compliance', expiry_months: 12, is_mandatory: false, tags: 'gdpr, privacy' });
      expect(r.status).toBe(201);
      expect(r.body.course).toEqual(expect.objectContaining({ name, is_active: true, mandatory: true, is_mandatory: false, expiry_months: 12, category: 'Compliance', organization_id: fx.A.id, self_enrol: false, feedback_enabled: true }));
      const id = r.body.course.id;

      const got = await adminA.get(`/api/admin/courses/${id}`).expect(200);
      expect(got.body.course).toEqual(expect.objectContaining({ id, enrolled_count: 0, is_active: true }));
      // Also reachable by public id.
      const [{ public_id }] = await dbQuery('SELECT public_id FROM courses WHERE id = $1', [id]);
      await adminA.get(`/api/admin/courses/${public_id}`).expect(200);

      // A rename that omits is_active keeps it published; moving out of Compliance clears the renewal.
      const put = await adminA.put(`/api/admin/courses/${id}`).send({ name: `${name}-x`, category: 'Technical' });
      expect(put.status).toBe(200);
      expect(put.body.course).toEqual(expect.objectContaining({ name: `${name}-x`, is_active: true, expiry_months: null, mandatory: false, tags: 'gdpr, privacy' }));

      // Activity row written for the publish.
      const act = await dbQuery("SELECT type FROM activity_log WHERE organization_id = $1 AND subject_type = 'course' AND subject_id = $2", [fx.A.id, id]);
      expect(act.map((a) => a.type)).toContain('course_published');
    });

    it('validates the course form', async () => {
      await adminA.post('/api/admin/courses').send({ name: '' }).expect(400);
      await adminA.post('/api/admin/courses').send({ name: uniq('C'), category: 'Astrology' }).expect(400);
      await adminA.post('/api/admin/courses').send({ name: uniq('C'), description: 'x'.repeat(451) }).expect(400);
      await adminA.post('/api/admin/courses').send({ name: uniq('C'), thumbnail_url: 'javascript:alert(1)' }).expect(422);
    });

    it('lists the library with stats, and archive swaps a course out and back in remembering draft state', async () => {
      const c = await buildCourse(adminA);
      const list = await adminA.get('/api/admin/courses').expect(200);
      const row = list.body.courses.find((x: { id: number }) => x.id === c.id);
      expect(row).toEqual(expect.objectContaining({ lessons_count: 1, is_active: true, enrollments_count: 0, needs_attention: true }));
      expect(list.body.stats.total).toBe(list.body.courses.length);
      expect(list.body.stats.published + list.body.stats.draft).toBe(list.body.stats.total);

      const unpub = await adminA.post('/api/admin/courses/bulk').send({ action: 'unpublish', course_ids: [c.id] });
      expect(unpub.status).toBe(200);
      expect(unpub.body).toEqual({ action: 'unpublish', affected: 1, requested: 1 });

      const arch = await adminA.post('/api/admin/courses/bulk').send({ action: 'archive', course_ids: [c.id] }).expect(200);
      expect(arch.body.affected).toBe(1);
      const live = await adminA.get('/api/admin/courses').expect(200);
      expect(live.body.courses.some((x: { id: number }) => x.id === c.id)).toBe(false);
      const archived = await adminA.get('/api/admin/courses?archived=true').expect(200);
      expect(archived.body.courses.some((x: { id: number }) => x.id === c.id)).toBe(true);
      expect(live.body.archived_count).toBeGreaterThanOrEqual(1);

      // Publishing an archived course is refused by the predicate (affects 0).
      const pubArchived = await adminA.post('/api/admin/courses/bulk').send({ action: 'publish', course_ids: [c.id] }).expect(200);
      expect(pubArchived.body.affected).toBe(0);

      await adminA.post('/api/admin/courses/bulk').send({ action: 'restore', course_ids: [c.id] }).expect(200);
      const back = await adminA.get(`/api/admin/courses/${c.id}`).expect(200);
      expect(back.body.course).toEqual(expect.objectContaining({ archived_at: null, is_active: false }));

      const pub = await adminA.post('/api/admin/courses/bulk').send({ action: 'publish', course_ids: [c.id] }).expect(200);
      expect(pub.body.affected).toBe(1);
    });

    it('keeps another organization out: 404 on read and write, bulk affects nothing', async () => {
      const c = await buildCourse(adminA);
      await adminB.get(`/api/admin/courses/${c.id}`).expect(404);
      await adminB.put(`/api/admin/courses/${c.id}`).send({ name: 'hijack' }).expect(404);
      await adminB.get(`/api/admin/courses/${c.id}/lessons`).expect(404);
      await adminB.post(`/api/admin/courses/${c.id}/modules`).send({ title: 'x' }).expect(404);
      await adminB.post(`/api/admin/courses/${c.id}/lessons`).send({ title: 'x', content_type: 'link', content_url: 'https://e.test', duration_minutes: 5 }).expect(404);
      const bulk = await adminB.post('/api/admin/courses/bulk').send({ action: 'archive', course_ids: [c.id] }).expect(200);
      expect(bulk.body.affected).toBe(0);
      const list = await adminB.get('/api/admin/courses').expect(200);
      expect(list.body.courses.some((x: { id: number }) => x.id === c.id)).toBe(false);
      await adminB.delete(`/api/admin/courses/${c.id}`).expect((r) => expect(r.status).toBeLessThan(500));
      const [still] = await dbQuery('SELECT id FROM courses WHERE id = $1', [c.id]);
      expect(still).toBeDefined();
    });

    it('refuses a learner and an admin without manage_courses', async () => {
      await learnerA.get('/api/admin/courses').expect(403);
      await learnerA.post('/api/admin/courses').send({ name: 'x' }).expect(403);
      await viewer.get('/api/admin/courses').expect(200); // content reads are open to admins
      await viewer.post('/api/admin/courses').send({ name: uniq('C') }).expect(403);
      const c = await buildCourse(adminA);
      await viewer.put(`/api/admin/courses/${c.id}`).send({ name: 'x' }).expect(403);
      await viewer.delete(`/api/admin/courses/${c.id}`).expect(403);
      await viewer.post('/api/admin/courses/bulk').send({ action: 'archive', course_ids: [c.id] }).expect(403);
      await viewer.post(`/api/admin/courses/${c.id}/modules`).send({ title: 'x' }).expect(403);
      await viewer.post(`/api/admin/modules/${c.moduleId}/lessons`).send({ title: 'x' }).expect(403);
      await viewer.delete(`/api/admin/lessons/${c.lessonIds[0]}`).expect(403);
    });

    it('deletes a course and everything under it', async () => {
      const c = await buildCourse(adminA);
      const r = await adminA.delete(`/api/admin/courses/${c.id}`).expect(200);
      expect(r.body.message).toMatch(/deleted/i);
      expect(await dbQuery('SELECT id FROM courses WHERE id = $1', [c.id])).toHaveLength(0);
      expect(await dbQuery('SELECT id FROM lessons WHERE id = $1', [c.lessonIds[0]])).toHaveLength(0);
      await adminA.get(`/api/admin/courses/${c.id}`).expect(404);
    });
  });

  describe('modules', () => {
    it('creates modules in order, reorders them, and a title edit keeps the position', async () => {
      const c = await buildCourse(adminA);
      const m2 = await adminA.post(`/api/admin/courses/${c.id}/modules`).send({ title: 'Module 2' }).expect(201);
      expect(m2.body.module.sortOrder).toBeGreaterThan(0);

      const listed = await adminA.get(`/api/admin/courses/${c.id}/modules`).expect(200);
      expect(listed.body.modules.map((m: { title: string }) => m.title)).toEqual(['Module 1', 'Module 2']);
      expect(listed.body.modules[0].lessons).toHaveLength(1);

      // Reorder: Module 2 first.
      await adminA.put(`/api/admin/modules/${m2.body.module.id}`).send({ title: 'Module 2', sort_order: 0 }).expect(200);
      await adminA.put(`/api/admin/modules/${c.moduleId}`).send({ title: 'Module 1', sort_order: 5 }).expect(200);
      const re = await adminA.get(`/api/admin/courses/${c.id}/modules`).expect(200);
      expect(re.body.modules.map((m: { title: string }) => m.title)).toEqual(['Module 2', 'Module 1']);

      // A title-only edit leaves the order alone.
      const t = await adminA.put(`/api/admin/modules/${c.moduleId}`).send({ title: 'Renamed' }).expect(200);
      expect(t.body.module).toEqual(expect.objectContaining({ title: 'Renamed', sortOrder: 5 }));

      await adminB.put(`/api/admin/modules/${c.moduleId}`).send({ title: 'x' }).expect(404);
      await viewer.put(`/api/admin/modules/${c.moduleId}`).send({ title: 'x' }).expect(403);
    });

    it('lists a module\'s lessons with resources, and deleting a module leaves its lessons staged', async () => {
      const c = await buildCourse(adminA, { lessons: 2 });
      const ls = await adminA.get(`/api/admin/modules/${c.moduleId}/lessons`).expect(200);
      expect(ls.body.lessons.map((l: { id: number }) => l.id)).toEqual(c.lessonIds);
      expect(ls.body.lessons[0].resources).toEqual([]);

      await viewer.delete(`/api/admin/modules/${c.moduleId}`).expect(403);
      await adminA.delete(`/api/admin/modules/${c.moduleId}`).expect(200);
      const rows = await dbQuery('SELECT id, module_id FROM lessons WHERE id = ANY($1)', [c.lessonIds]);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.module_id === null)).toBe(true);
      const course = await adminA.get(`/api/admin/courses/${c.id}/lessons`).expect(200);
      expect(course.body.lessons.every((l: { staged: boolean }) => l.staged)).toBe(true);
    });
  });

  describe('lessons', () => {
    it('enforces content and declared duration rules', async () => {
      const c = await buildCourse(adminA);
      await adminA.post(`/api/admin/modules/${c.moduleId}/lessons`).send({ title: 'No url', content_type: 'link', duration_minutes: 5 }).expect(422);
      await adminA.post(`/api/admin/modules/${c.moduleId}/lessons`).send({ title: 'No duration', content_type: 'link', content_url: 'https://e.test' }).expect(422);
      await adminA.post(`/api/admin/modules/${c.moduleId}/lessons`).send({ title: 'Video no source', content_type: 'video' }).expect(422);
      await adminA.post(`/api/admin/modules/${c.moduleId}/lessons`).send({ title: 'Scorm no pkg', content_type: 'scorm', duration_minutes: 5 }).expect(422);
      await adminA.post(`/api/admin/modules/${c.moduleId}/lessons`).send({ title: 'Bad type', content_type: 'hologram' }).expect(400);
      // A linked video measures itself, so no duration is needed.
      const v = await adminA.post(`/api/admin/modules/${c.moduleId}/lessons`).send({ title: 'Linked video', content_type: 'video', content_url: 'https://e.test/v.mp4' });
      expect(v.status).toBe(201);
      expect(v.body.lesson).toEqual(expect.objectContaining({ contentType: 'video', moduleId: c.moduleId, courseId: c.id }));
    });

    it('creates a staged lesson at course level, places it, and unplaces it', async () => {
      const c = await buildCourse(adminA);
      const other = await buildCourse(adminA);
      const s = await adminA.post(`/api/admin/courses/${c.id}/lessons`).send({ title: 'Staged', content_type: 'link', content_url: 'https://e.test/s', duration_minutes: 7 });
      expect(s.status).toBe(201);
      expect(s.body.lesson.moduleId).toBeNull();
      const staged = s.body.lesson.id;

      // Placed straight away when module_id is given.
      const placed = await adminA.post(`/api/admin/courses/${c.id}/lessons`).send({ title: 'Placed', content_type: 'link', content_url: 'https://e.test/p', duration_minutes: 7, module_id: c.moduleId }).expect(201);
      expect(placed.body.lesson.moduleId).toBe(c.moduleId);
      // A module from another course is refused.
      await adminA.post(`/api/admin/courses/${c.id}/lessons`).send({ title: 'x', content_type: 'link', content_url: 'https://e.test', duration_minutes: 7, module_id: other.moduleId }).expect(422);

      const list = await adminA.get(`/api/admin/courses/${c.id}/lessons`).expect(200);
      const byId = Object.fromEntries(list.body.lessons.map((l: { id: number; staged: boolean }) => [l.id, l.staged]));
      expect(byId[staged]).toBe(true);
      expect(byId[c.lessonIds[0]]).toBe(false);

      const link = await adminA.patch(`/api/admin/lessons/${staged}/module`).send({ module_id: c.moduleId }).expect(200);
      expect(link.body.lesson).toEqual(expect.objectContaining({ staged: false, moduleId: c.moduleId }));
      await adminA.patch(`/api/admin/lessons/${staged}/module`).send({ module_id: other.moduleId }).expect(422);
      const unlink = await adminA.patch(`/api/admin/lessons/${staged}/module`).send({ module_id: null }).expect(200);
      expect(unlink.body.lesson.staged).toBe(true);
      await adminB.patch(`/api/admin/lessons/${staged}/module`).send({ module_id: null }).expect(404);
      await viewer.patch(`/api/admin/lessons/${staged}/module`).send({ module_id: null }).expect(403);
    });

    it('updates a lesson partially and deletes it', async () => {
      const c = await buildCourse(adminA);
      const id = c.lessonIds[0];
      const u = await adminA.put(`/api/admin/lessons/${id}`).send({ title: 'New title' }).expect(200);
      expect(u.body.lesson).toEqual(expect.objectContaining({ title: 'New title', durationMinutes: 10, contentUrl: 'https://example.test/l1' }));
      await adminA.put(`/api/admin/lessons/${id}`).send({ duration_minutes: 0 }).expect(422);
      await adminB.put(`/api/admin/lessons/${id}`).send({ title: 'x' }).expect(404);
      await viewer.put(`/api/admin/lessons/${id}`).send({ title: 'x' }).expect(403);
      await adminA.delete(`/api/admin/lessons/${id}`).expect(200);
      expect(await dbQuery('SELECT id FROM lessons WHERE id = $1', [id])).toHaveLength(0);
    });
  });

  describe('resources', () => {
    it('adds a linked resource, refuses incomplete ones, lists and deletes', async () => {
      const c = await buildCourse(adminA);
      const lessonId = c.lessonIds[0];
      await adminA.post(`/api/admin/lessons/${lessonId}/resources`).send({ title: 'No url', source: 'link' }).expect(422);
      await adminA.post(`/api/admin/lessons/${lessonId}/resources`).send({ title: 'No file', source: 'upload' }).expect(422);
      // An upload key that does not exist in storage is refused, never recorded.
      await adminA.post(`/api/admin/lessons/${lessonId}/resources`).send({ title: 'Ghost', source: 'upload', file_key: 'lessons/documents/incoming/ghost.pdf' }).expect(422);
      await viewer.post(`/api/admin/lessons/${lessonId}/resources`).send({ title: 'x', source: 'link', url: 'https://e.test' }).expect(403);

      const r = await adminA.post(`/api/admin/lessons/${lessonId}/resources`).send({ title: 'Spec', source: 'link', url: 'https://e.test/spec' }).expect(201);
      expect(r.body.resource).toEqual(expect.objectContaining({ title: 'Spec', source: 'link', resourceType: 'link', url: 'https://e.test/spec' }));
      const list = await adminA.get(`/api/admin/lessons/${lessonId}/resources`).expect(200);
      expect(list.body.resources.map((x: { title: string }) => x.title)).toEqual(['Spec']);
      await adminB.get(`/api/admin/lessons/${lessonId}/resources`).expect(404);

      // A resource never carries a duration: learning hours are unchanged by it.
      const [lesson] = await dbQuery('SELECT duration_minutes FROM lessons WHERE id = $1', [lessonId]);
      expect(lesson.duration_minutes).toBe(10);

      await adminB.delete(`/api/admin/resources/${r.body.resource.id}`).expect(404);
      await viewer.delete(`/api/admin/resources/${r.body.resource.id}`).expect(403);
      await adminA.delete(`/api/admin/resources/${r.body.resource.id}`).expect(200);
      expect(await dbQuery('SELECT id FROM lesson_resources WHERE id = $1', [r.body.resource.id])).toHaveLength(0);
    });
  });

  describe('assignments', () => {
    it('assigns one learner (201), re-assigning updates the due date (200)', async () => {
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      const a = await adminA.post(`/api/admin/courses/${c.id}/assignments`).send({ user_id: p.id });
      expect(a.status).toBe(201);
      expect(a.body.message).toMatch(/assigned/i);
      const again = await adminA.post(`/api/admin/courses/${c.id}/assignments`).send({ user_id: p.id, due_date: '2030-01-31' });
      expect(again.status).toBe(200);
      expect(again.body.message).toBe('Assignment updated');
      const [row] = await dbQuery('SELECT due_date::text AS d, assigned_by FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, c.id]);
      expect(row.d).toMatch(/^2030-01-31/);
      expect(row.assigned_by).toBe(fx.A.admin.id);

      await adminA.post(`/api/admin/courses/${c.id}/assignments`).send({ user_id: fx.B.learner.id }).expect(404);
      await adminB.post(`/api/admin/courses/${c.id}/assignments`).send({ user_id: fx.B.learner.id }).expect(404);
      await viewer.post(`/api/admin/courses/${c.id}/assignments`).send({ user_id: p.id }).expect(403);
    });

    it('bulk assigns, counts only the new ones, and tells each learner', async () => {
      const c = await buildCourse(adminA);
      const p1 = await newPerson(adminA, fx.A);
      const p2 = await newPerson(adminA, fx.A);
      await adminA.post(`/api/admin/courses/${c.id}/assignments`).send({ user_id: p1.id }).expect(201);
      const r = await adminA.post(`/api/admin/courses/${c.id}/assignments/bulk`).send({ user_ids: [p1.id, p2.id], due_date: '2030-06-01' });
      expect(r.status).toBe(201);
      expect(r.body.requested).toBe(2);
      // Re-assigning an existing learner applies the new due date.
      const [due] = await dbQuery('SELECT due_date::text AS d FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p1.id, c.id]);
      expect(due.d).toMatch(/^2030-06-01/);

      const n = await eventually(() => notificationsOf(p2.id, 'course_assigned'), (v) => v.length > 0);
      expect(n[0].title).toContain(c.name);
      const act = await dbQuery("SELECT 1 FROM activity_log WHERE organization_id = $1 AND type = 'learning_assigned' AND subject_id = $2", [fx.A.id, c.id]);
      expect(act.length).toBeGreaterThan(0);

      await adminA.post(`/api/admin/courses/${c.id}/assignments/bulk`).send({ user_ids: [p1.id, fx.B.learner.id] }).expect(404);
      await adminA.post(`/api/admin/courses/${c.id}/assignments/bulk`).send({ user_ids: [] }).expect(400);
      await viewer.post(`/api/admin/courses/${c.id}/assignments/bulk`).send({ user_ids: [p1.id] }).expect(403);

      const list = await adminA.get(`/api/admin/courses/${c.id}/assignments`).expect(200);
      expect(list.body.assignments.map((x: { user_id: number }) => x.user_id).sort()).toEqual([p1.id, p2.id].sort());
      expect(list.body.assignments[0]).toEqual(expect.objectContaining({ total_lessons: expect.anything(), scorm_results: [] }));
      const other = await adminB.get(`/api/admin/courses/${c.id}/assignments`).expect(200);
      expect(other.body.assignments).toEqual([]);

      const course = await adminA.get(`/api/admin/courses/${c.id}`).expect(200);
      expect(course.body.course.enrolled_count).toBe(2);
    });

    it('removes an assignment; another organization cannot', async () => {
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      await assign(adminA, c.id, [p.id]);
      const [{ id }] = await dbQuery('SELECT id FROM user_course_assignments WHERE user_id = $1 AND course_id = $2', [p.id, c.id]);
      await viewer.delete(`/api/admin/assignments/${id}`).expect(403);
      await adminB.delete(`/api/admin/assignments/${id}`).expect((r) => expect(r.status).toBeLessThan(500));
      expect(await dbQuery('SELECT id FROM user_course_assignments WHERE id = $1', [id])).toHaveLength(1);
      await adminA.delete(`/api/admin/assignments/${id}`).expect(200);
      expect(await dbQuery('SELECT id FROM user_course_assignments WHERE id = $1', [id])).toHaveLength(0);
    });

    it('bulk assign counts only newly assigned learners', async () => {
      const c = await buildCourse(adminA);
      const p1 = await newPerson(adminA, fx.A);
      const p2 = await newPerson(adminA, fx.A);
      await assign(adminA, c.id, [p1.id]);
      const r = await adminA.post(`/api/admin/courses/${c.id}/assignments/bulk`).send({ user_ids: [p1.id, p2.id] });
      expect(r.body).toEqual({ assigned: 1, requested: 2 });
    });

    it('an archived course cannot be assigned through the API', async () => {
      // CONTEXT.md "Archived": an archived item can't be assigned again.
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      await adminA.post('/api/admin/courses/bulk').send({ action: 'archive', course_ids: [c.id] }).expect(200);
      const r = await adminA.post(`/api/admin/courses/${c.id}/assignments`).send({ user_id: p.id });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('the learner side', () => {
    let course: Awaited<ReturnType<typeof buildCourse>>;
    let me: Person;
    let meAgent: Agent;
    let stagedId: number;

    beforeAll(async () => {
      course = await buildCourse(adminA, { lessons: 2 });
      const s = await adminA.post(`/api/admin/courses/${course.id}/lessons`).send({ title: 'Staged secret', content_type: 'link', content_url: 'https://e.test/hidden', duration_minutes: 99 });
      stagedId = s.body.lesson.id;
      me = await newPerson(adminA, fx.A);
      meAgent = await signIn(app, me);
      await assign(adminA, course.id, [me.id]);
    });

    it('lists the course in My Courses and hides staged lessons from the course read', async () => {
      const list = await meAgent.get('/api/learner/courses').expect(200);
      expect(JSON.stringify(list.body)).toContain(course.name);
      const d = await meAgent.get(`/api/learner/courses/${course.publicId}`).expect(200);
      const lessons = d.body.modules.flatMap((m: { lessons: { id: number }[] }) => m.lessons.map((l) => Number(l.id)));
      expect(lessons).toEqual(course.lessonIds);
      expect(lessons).not.toContain(stagedId);
      expect(d.body.course.lessons_count).toBe(2);
      expect(d.body.enrollment).toEqual(expect.objectContaining({ status: 'active', progress_percentage: 0 }));
      expect(d.body.modules[0].lessons[1].is_locked).toBe(true);
      // A staged lesson cannot be opened at all.
      const st = await meAgent.get(`/api/learner/lessons/${stagedId}`);
      expect([403, 404]).toContain(st.status);
    });

    it('refuses an unassigned learner and another organization', async () => {
      await learnerA.get(`/api/learner/courses/${course.publicId}`).expect(404);
      await learnerA.get(`/api/learner/lessons/${course.lessonIds[0]}`).expect(403);
      await learnerA.post(`/api/learner/lessons/${course.lessonIds[0]}/complete`).expect(403);
      await learnerB.get(`/api/learner/courses/${course.publicId}`).expect(404);
      await learnerB.get(`/api/learner/lessons/${course.lessonIds[0]}`).expect(404);
    });

    it('locks the second lesson until the first is complete', async () => {
      const locked = await meAgent.get(`/api/learner/lessons/${course.lessonIds[1]}`);
      expect(locked.status).toBe(403);
      expect(locked.body.message).toMatch(/locked/i);
      const first = await meAgent.get(`/api/learner/lessons/${course.lessonIds[0]}`).expect(200);
      expect(first.body.lesson.content_url).toBe('https://example.test/l1');
      expect(first.body.total).toBe(2);
    });

    it('a locked lesson cannot be completed by POSTing directly (sequential lock enforced on write)', async () => {
      // CONTEXT.md Lesson completion: "A Lesson inside a Module stays locked until the one before it is complete."
      const p = await newPerson(adminA, fx.A);
      const ag = await signIn(app, p);
      await assign(adminA, course.id, [p.id]);
      await ag.post(`/api/learner/lessons/${course.lessonIds[1]}/complete`).expect(403);
    });

    it('completing every lesson completes the course: certificate, notification, points', async () => {
      const before = await meAgent.get('/api/learner/leaderboard').expect(200);
      const pointsBefore = before.body.me?.allTimePoints ?? 0;

      await meAgent.post(`/api/learner/lessons/${course.lessonIds[0]}/complete`).expect((r) => ok(r));
      expect(await dbQuery('SELECT id FROM certificates WHERE user_id = $1 AND course_id = $2', [me.id, course.id])).toHaveLength(0);
      await meAgent.get(`/api/learner/lessons/${course.lessonIds[1]}`).expect(200);
      const done = await meAgent.post(`/api/learner/lessons/${course.lessonIds[1]}/complete`);
      ok(done);
      expect(done.body.message).toMatch(/complete/i);

      const certs = await dbQuery('SELECT organization_id FROM certificates WHERE user_id = $1 AND course_id = $2', [me.id, course.id]);
      expect(certs).toHaveLength(1);
      expect(certs[0].organization_id).toBe(fx.A.id);
      const n = await eventually(() => notificationsOf(me.id, 'course_completed'), (v) => v.length > 0);
      expect(n.length).toBe(1);

      const d = await meAgent.get(`/api/learner/courses/${course.id}`).expect(200);
      expect(d.body.enrollment).toEqual(expect.objectContaining({ status: 'completed', progress_percentage: 100 }));

      // Course completed (100) plus finished early (75); the staged lesson is not needed.
      const after = await meAgent.get('/api/learner/leaderboard').expect(200);
      expect(after.body.me.allTimePoints - pointsBefore).toBe(175);

      // Completing again earns nothing more and issues no second certificate.
      await meAgent.post(`/api/learner/lessons/${course.lessonIds[1]}/complete`).expect((r) => ok(r));
      expect(await dbQuery('SELECT id FROM certificates WHERE user_id = $1 AND course_id = $2', [me.id, course.id])).toHaveLength(1);
    });
  });
});
