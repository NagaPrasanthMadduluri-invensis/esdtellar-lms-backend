/**
 * Course preview (CONTEXT.md §5 Course preview, BACKEND_STRUCTURE §10.64): an
 * Admin opens any course in their content scope as a learner sees it, draft
 * or published, to audit and test it. Every read is the learner's shape;
 * nothing the Admin does is recorded. Another organization's course is a 404,
 * and the learner portal cannot reach any of it.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, signIn, type Agent } from './helpers';
import { buildCourse, limitedAdmin, type BuiltCourse } from './support/2';

describe('course preview (admin)', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let viewer: Agent; // admin portal, no manage_courses: content reads stay open
  let c: BuiltCourse;
  let assessmentId: number;
  let correct: number;
  let wrong: number;
  let resourceId: number;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    viewer = (await limitedAdmin(app, adminA, fx.A, ['view_dashboard'])).agent;

    // A DRAFT course: two lessons, a link resource, an assessment of one question.
    c = await buildCourse(adminA, { lessons: 2, extra: { is_active: false } });
    const a = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Check', passing_score: 60 });
    assessmentId = a.body.assessment.id;
    const q = await adminA.post(`/api/admin/assessments/${assessmentId}/questions`).send({
      question_text: 'Capital of France?', question_type: 'mcq',
      options: [{ option_text: 'Paris', is_correct: true }, { option_text: 'Rome' }],
    });
    expect(q.status).toBeLessThan(300);
    const opts = await dbQuery<{ id: number; is_correct: number }>(
      'SELECT o.id, o.is_correct FROM assessment_options o JOIN assessment_questions q ON q.id = o.question_id WHERE q.assessment_id = $1 ORDER BY o.id',
      [assessmentId],
    );
    correct = Number(opts.find((o) => Number(o.is_correct) === 1)!.id);
    wrong = Number(opts.find((o) => Number(o.is_correct) !== 1)!.id);
    const r = await adminA.post(`/api/admin/lessons/${c.lessonIds[0]}/resources`).send({ title: 'Cheat sheet', source: 'link', url: 'https://example.test/sheet' });
    expect(r.status).toBeLessThan(300);
    [{ id: resourceId }] = await dbQuery<{ id: number }>('SELECT id FROM lesson_resources WHERE lesson_id = $1', [c.lessonIds[0]]);
  });
  afterAll(async () => { await app.close(); });

  it('opens a draft course as a learner sees it, every lesson open, with no enrolment', async () => {
    const r = await adminA.get(`/api/admin/courses/${c.publicId}/preview`).expect(200);
    expect(r.body).toEqual(expect.objectContaining({ preview: true, enrollment: null, reward: null, assessmentsUnlocked: true }));
    expect(r.body.course).toEqual(expect.objectContaining({ id: c.id, name: c.name, is_active: 0, lessons_count: 2, modules_count: 1 }));
    const lessons = r.body.modules[0].lessons;
    expect(lessons.map((l: { is_locked: boolean }) => l.is_locked)).toEqual([false, false]);
    // Not yet Live (a new assessment starts off), yet it previews so it can be tried first.
    expect(r.body.assessments).toEqual([expect.objectContaining({ id: assessmentId, is_active: 0, attempt_count: 0, last_attempt: null })]);

    // By integer id too; any admin-portal role may preview (a content read).
    await adminA.get(`/api/admin/courses/${c.id}/preview`).expect(200);
    await viewer.get(`/api/admin/courses/${c.id}/preview`).expect(200);
  });

  it('opens the second lesson directly, no lock, and its resource link', async () => {
    const r = await adminA.get(`/api/admin/lessons/${c.lessonIds[1]}/preview`).expect(200);
    expect(r.body).toEqual(expect.objectContaining({ preview: true, progress_status: 'not_started', position: 2, total: 2, next_lesson: null }));
    expect(r.body.playlist.map((l: { status: string }) => l.status)).toEqual(['available', 'current']);
    expect(r.body.lesson).toEqual(expect.objectContaining({ title: 'Lesson 2', content_type: 'link', content_url: 'https://example.test/l2' }));

    const first = await adminA.get(`/api/admin/lessons/${c.lessonIds[0]}/preview`).expect(200);
    expect(first.body.resources).toEqual([expect.objectContaining({ id: resourceId, title: 'Cheat sheet', url: 'https://example.test/sheet' })]);
    const link = await adminA.get(`/api/admin/resources/${resourceId}/url`).expect(200);
    expect(link.body).toEqual(expect.objectContaining({ url: 'https://example.test/sheet', title: 'Cheat sheet' }));
  });

  it('describes the lesson media for the player, and streams a document through the checked admin route', async () => {
    const m = await adminA.get(`/api/admin/lessons/${c.lessonIds[0]}/media`).expect(200);
    expect(m.body).toEqual(expect.objectContaining({ hasVideo: false, videoUrl: null, documentUrl: null, watchedSeconds: 0 }));

    await dbQuery("UPDATE lessons SET document_key = 'lessons/documents/incoming/p.pdf', document_name = 'p.pdf', document_mime = 'application/pdf' WHERE id = $1", [c.lessonIds[1]]);
    const d = await adminA.get(`/api/admin/lessons/${c.lessonIds[1]}/media`).expect(200);
    expect(d.body).toEqual(expect.objectContaining({ documentUrl: `/api/admin/lessons/${c.lessonIds[1]}/document`, documentName: 'p.pdf' }));
    // Streaming needs R2, absent in the test runtime: the documented 503.
    expect((await adminA.get(`/api/admin/lessons/${c.lessonIds[1]}/document`)).status).toBe(503);
    // A lesson with no document is a 404.
    await adminA.get(`/api/admin/lessons/${c.lessonIds[0]}/document`).expect(404);
  });

  it('shows the assessment without its answer key and grades a try, recording nothing', async () => {
    const a = await adminA.get(`/api/admin/assessments/${assessmentId}/preview`).expect(200);
    expect(a.body).toEqual(expect.objectContaining({ preview: true, attempt_count: 0 }));
    expect(a.body.questions[0].options.every((o: Record<string, unknown>) => !('is_correct' in o))).toBe(true);

    const pass = await adminA.post(`/api/admin/assessments/${assessmentId}/preview-attempt`)
      .send({ answers: [{ question_id: a.body.questions[0].id, selected_option_id: correct }] }).expect(200);
    expect(pass.body.result).toEqual(expect.objectContaining({ attempt_id: null, score: 1, percentage: 100, is_passed: true, preview: true }));
    const fail = await adminA.post(`/api/admin/assessments/${assessmentId}/preview-attempt`)
      .send({ answers: [{ question_id: a.body.questions[0].id, selected_option_id: wrong }] }).expect(200);
    expect(fail.body.result).toEqual(expect.objectContaining({ score: 0, is_passed: false }));
    await adminA.post(`/api/admin/assessments/${assessmentId}/preview-attempt`).send({ answers: 'nope' }).expect(400);

    // Nothing written for the admin: no attempt, no completion, no certificate.
    const admin = fx.A.admin.id;
    expect(await dbQuery('SELECT 1 FROM user_assessment_attempts WHERE assessment_id = $1', [assessmentId])).toHaveLength(0);
    expect(await dbQuery('SELECT 1 FROM user_lesson_completions WHERE user_id = $1 AND lesson_id = ANY($2)', [admin, c.lessonIds])).toHaveLength(0);
    expect(await dbQuery('SELECT 1 FROM certificates WHERE user_id = $1 AND course_id = $2', [admin, c.id])).toHaveLength(0);
  });

  it('another organization\'s admin gets 404 on every preview read; the learner portal gets 403', async () => {
    await adminB.get(`/api/admin/courses/${c.id}/preview`).expect(404);
    await adminB.get(`/api/admin/lessons/${c.lessonIds[0]}/preview`).expect(404);
    await adminB.get(`/api/admin/lessons/${c.lessonIds[1]}/document`).expect(404);
    await adminB.get(`/api/admin/resources/${resourceId}/url`).expect(404);
    await adminB.get(`/api/admin/assessments/${assessmentId}/preview`).expect(404);
    await adminB.post(`/api/admin/assessments/${assessmentId}/preview-attempt`).send({ answers: [] }).expect(404);

    await learnerA.get(`/api/admin/courses/${c.id}/preview`).expect(403);
    await learnerA.get(`/api/admin/lessons/${c.lessonIds[0]}/preview`).expect(403);
    await learnerA.get(`/api/admin/resources/${resourceId}/url`).expect(403);
    await learnerA.post(`/api/admin/assessments/${assessmentId}/preview-attempt`).send({ answers: [] }).expect(403);
  });
});
