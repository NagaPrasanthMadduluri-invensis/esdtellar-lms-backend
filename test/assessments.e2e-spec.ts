/**
 * Assessments (CONTEXT.md §5 Assessment, Live, Placement, Question type; §7
 * Course completion): building, placement, the five question types, Live,
 * learner attempts with the best passing score, and completion gated on a pass.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, type Agent } from './helpers';
import { assign, buildCourse, limitedAdmin } from './support/2';

const mcq = (text = 'Capital of France?') => ({
  question_text: text,
  question_type: 'mcq',
  options: [{ option_text: 'Paris', is_correct: true }, { option_text: 'Rome' }, { option_text: 'Oslo' }],
});
const tf = () => ({ question_text: 'The sky is blue', question_type: 'truefalse', options: [{ option_text: 'True', is_correct: true }, { option_text: 'False' }] });

type Q = { id: number; question_type: string; correct_answer: string | null; options: { id: number; option_text: string; is_correct?: number }[] };

describe('assessments', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learnerA: Agent;
  let learnerB: Agent;
  let noBuild: Agent; // admin without build_assessments / manage_assessments

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learnerA = await signIn(app, fx.A.learner);
    learnerB = await signIn(app, fx.B.learner);
    noBuild = (await limitedAdmin(app, adminA, fx.A, ['manage_courses'])).agent;
  });
  afterAll(async () => { await app.close(); });

  describe('building', () => {
    it('starts not Live, placed as the final by default; lists per course and org-wide', async () => {
      const c = await buildCourse(adminA);
      const r = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Final quiz' });
      expect(r.status).toBe(201);
      expect(r.body.assessment).toEqual(expect.objectContaining({ title: 'Final quiz', isActive: 0, linkType: 'course', passingScore: 60, courseId: c.id }));
      const id = r.body.assessment.id;

      const byCourse = await adminA.get(`/api/admin/courses/${c.id}/assessments`).expect(200);
      expect(byCourse.body.assessments.map((a: { id: number }) => a.id)).toEqual([id]);
      const all = await adminA.get('/api/admin/all-assessments').expect(200);
      expect(all.body.assessments.find((a: { id: number }) => a.id === id)).toEqual(expect.objectContaining({ is_active: false, course_name: c.name }));
      const allB = await adminB.get('/api/admin/all-assessments').expect(200);
      expect(allB.body.assessments.some((a: { id: number }) => a.id === id)).toBe(false);
      const byCourseB = await adminB.get(`/api/admin/courses/${c.id}/assessments`).expect(200);
      expect(byCourseB.body.assessments).toEqual([]);

      await learnerA.get('/api/admin/all-assessments').expect(403);
      await noBuild.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'x' }).expect(403);
      await adminB.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'x' }).expect(404);

      const act = await dbQuery("SELECT 1 FROM activity_log WHERE type = 'assessment_created' AND subject_id = $1", [id]);
      expect(act).toHaveLength(1);
    });

    it('places at a module, a lesson or none, and refuses a placement outside the course', async () => {
      const c = await buildCourse(adminA);
      const other = await buildCourse(adminA);
      const mod = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Module quiz', link_type: 'module', module_id: c.moduleId }).expect(201);
      expect(mod.body.assessment).toEqual(expect.objectContaining({ linkType: 'module', moduleId: c.moduleId, lessonId: null }));
      const les = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Lesson quiz', link_type: 'lesson', lesson_id: c.lessonIds[0] }).expect(201);
      expect(les.body.assessment).toEqual(expect.objectContaining({ linkType: 'lesson', lessonId: c.lessonIds[0], moduleId: null }));
      const none = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Draft', link_type: 'none' }).expect(201);
      expect(none.body.assessment.linkType).toBe('none');

      await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'x', link_type: 'module' }).expect(400);
      await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'x', link_type: 'module', module_id: other.moduleId }).expect(404);
      await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'x', link_type: 'lesson', lesson_id: other.lessonIds[0] }).expect(404);
      await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'x', link_type: 'shelf' }).expect(400);

      // Deleting the module never deletes the assessment hung on it.
      await adminA.delete(`/api/admin/modules/${c.moduleId}`).expect(200);
      const [row] = await dbQuery('SELECT module_id FROM assessments WHERE id = $1', [mod.body.assessment.id]);
      expect(row).toEqual({ module_id: null });
    });

    it('deleting the module an assessment hung on moves it to none (CONTEXT: Placement)', async () => {
      const c = await buildCourse(adminA);
      const mod = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Module quiz', link_type: 'module', module_id: c.moduleId }).expect(201);
      await adminA.delete(`/api/admin/modules/${c.moduleId}`).expect(200);
      const [row] = await dbQuery('SELECT link_type, module_id FROM assessments WHERE id = $1', [mod.body.assessment.id]);
      expect(row).toEqual({ link_type: 'none', module_id: null });
    });

    it('stores all five question types and enforces each shape', async () => {
      const c = await buildCourse(adminA);
      const { body: { assessment: a } } = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Five types' }).expect(201);
      const add = (q: object) => adminA.post(`/api/admin/assessments/${a.id}/questions`).send(q);

      // Refusals.
      await add({ question_text: 'one option', options: [{ option_text: 'A', is_correct: true }] }).expect(400);
      await add({ question_text: 'none correct', options: [{ option_text: 'A' }, { option_text: 'B' }] }).expect(400);
      await add({ question_text: 'two correct mcq', options: [{ option_text: 'A', is_correct: true }, { option_text: 'B', is_correct: true }] }).expect(400);
      await add({ question_text: 'tf three', question_type: 'truefalse', options: [{ option_text: 'T', is_correct: true }, { option_text: 'F' }, { option_text: 'M' }] }).expect(400);
      await add({ question_text: 'blank no answer', question_type: 'fillblank' }).expect(400);
      await add({ question_text: 'matching no pairs', question_type: 'matching' }).expect(400);
      await add({ question_text: 'essay', question_type: 'essay' }).expect(400);
      await noBuild.post(`/api/admin/assessments/${a.id}/questions`).send(mcq()).expect(403);
      await adminB.post(`/api/admin/assessments/${a.id}/questions`).send(mcq()).expect(404);

      const m = await add(mcq()).expect(201);
      expect(m.body.question).toEqual(expect.objectContaining({ question_type: 'mcq', question_text: 'Capital of France?', correct_answer: null }));
      expect(m.body.question.options).toHaveLength(3);
      await add(tf()).expect(201);
      const ms = await add({ question_text: 'Primes', question_type: 'multiselect', options: [{ option_text: '2', is_correct: true }, { option_text: '3', is_correct: true }, { option_text: '4' }] }).expect(201);
      expect(ms.body.question.options).toHaveLength(3);
      const fb = await add({ question_text: 'The capital of Italy is ___', question_type: 'fillblank', correct_answer: 'Rome', options: [{ option_text: 'ignored' }] }).expect(201);
      expect(fb.body.question).toEqual(expect.objectContaining({ question_type: 'fillblank', correct_answer: 'Rome', options: [] }));
      await add({ question_text: 'Match', question_type: 'matching', correct_answer: 'A=1;B=2' }).expect(201);

      const got = await adminA.get(`/api/admin/assessments/${a.id}`).expect(200);
      expect(got.body.assessment).toEqual(expect.objectContaining({ id: a.id, course_id: c.id, link_type: 'course', passing_score: 60 }));
      expect(got.body.questions.map((q: Q) => q.question_type)).toEqual(['mcq', 'truefalse', 'multiselect', 'fillblank', 'matching']);
      // The admin read carries which option is correct.
      const mq = got.body.questions[0] as Q;
      expect(mq.options.filter((o) => Number(o.is_correct) === 1).map((o) => o.option_text)).toEqual(['Paris']);
      await adminB.get(`/api/admin/assessments/${a.id}`).expect(404);

      // Edit: change the mcq into a fill-in-the-blank; its options go.
      const ed = await adminA.put(`/api/admin/questions/${mq.id}`).send({ question_text: 'Capital of Spain?', question_type: 'fillblank', correct_answer: 'Madrid' }).expect(200);
      expect(ed.body.question).toEqual(expect.objectContaining({ question_type: 'fillblank', correct_answer: 'Madrid', options: [] }));
      expect(await dbQuery('SELECT id FROM assessment_options WHERE question_id = $1', [mq.id])).toHaveLength(0);
      await adminB.put(`/api/admin/questions/${mq.id}`).send(mcq()).expect(404);
      await noBuild.put(`/api/admin/questions/${mq.id}`).send(mcq()).expect(403);

      await noBuild.delete(`/api/admin/questions/${mq.id}`).expect(403);
      await adminB.delete(`/api/admin/questions/${mq.id}`).expect((r) => expect(r.status).toBeLessThan(500));
      expect(await dbQuery('SELECT id FROM assessment_questions WHERE id = $1', [mq.id])).toHaveLength(1);
      await adminA.delete(`/api/admin/questions/${mq.id}`).expect(200);
      expect(await dbQuery('SELECT id FROM assessment_questions WHERE id = $1', [mq.id])).toHaveLength(0);
    });

    it('updates an assessment keeping its placement when omitted, goes Live and back, and deletes', async () => {
      const c = await buildCourse(adminA);
      const { body: { assessment: a } } = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Q', link_type: 'module', module_id: c.moduleId }).expect(201);
      const u = await adminA.put(`/api/admin/assessments/${a.id}`).send({ title: 'Q2', passing_score: 80 }).expect(200);
      expect(u.body.assessment).toEqual(expect.objectContaining({ title: 'Q2', passingScore: 80, linkType: 'module', moduleId: c.moduleId, isActive: 0 }));
      await noBuild.put(`/api/admin/assessments/${a.id}`).send({ title: 'x' }).expect(403);
      await adminB.put(`/api/admin/assessments/${a.id}`).send({ title: 'x' }).expect(404);

      await noBuild.post(`/api/admin/assessments/${a.id}/attach`).expect(403);
      await adminB.post(`/api/admin/assessments/${a.id}/attach`).expect(404);
      const live = await adminA.post(`/api/admin/assessments/${a.id}/attach`).expect(200);
      expect(live.body).toEqual(expect.objectContaining({ attached: true }));
      expect(live.body.assessment.isActive).toBe(1);
      await noBuild.delete(`/api/admin/assessments/${a.id}/attach`).expect(403);
      const off = await adminA.delete(`/api/admin/assessments/${a.id}/attach`).expect(200);
      expect(off.body.assessment.isActive).toBe(0);

      await noBuild.delete(`/api/admin/assessments/${a.id}`).expect(403);
      await adminA.delete(`/api/admin/assessments/${a.id}`).expect(200);
      expect(await dbQuery('SELECT id FROM assessments WHERE id = $1', [a.id])).toHaveLength(0);
    });
  });

  describe('sitting it', () => {
    it('hides a not-Live assessment, counts the best score, and completes the course only on a pass', async () => {
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      await assign(adminA, c.id, [p.id]);
      const { body: { assessment: a } } = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Final', passing_score: 60 }).expect(201);
      await adminA.post(`/api/admin/assessments/${a.id}/questions`).send(mcq()).expect(201);
      await adminA.post(`/api/admin/assessments/${a.id}/questions`).send(tf()).expect(201);
      const [{ public_id: pub }] = await dbQuery('SELECT public_id FROM assessments WHERE id = $1', [a.id]);

      // Not Live: invisible to the learner.
      const pre = await me.get('/api/learner/assessments').expect(200);
      expect(pre.body.assessments.some((x: { id: number }) => x.id === a.id)).toBe(false);
      await me.get(`/api/learner/assessments/${pub}`).expect(404);
      await me.post(`/api/learner/assessments/${pub}/attempt`).send({ answers: [] }).expect(404);

      await adminA.post(`/api/admin/assessments/${a.id}/attach`).expect(200);
      const list = await me.get('/api/learner/assessments').expect(200);
      const row = list.body.assessments.find((x: { id: number }) => x.id === a.id);
      expect(row).toEqual(expect.objectContaining({ questions_count: 2, attempt_count: 0, best_score: null, is_unlocked: false, has_passed: false }));

      const view = await me.get(`/api/learner/assessments/${pub}`).expect(200);
      expect(view.body.questions).toHaveLength(2);
      // The learner never sees which option is correct.
      expect(JSON.stringify(view.body.questions)).not.toMatch(/is_correct/);
      const [q1, q2] = view.body.questions as Q[];
      const opt = (q: Q, t: string) => q.options.find((o) => o.option_text === t)!.id;

      // Unassigned learner refused, other org cannot see it.
      await learnerA.get(`/api/learner/assessments/${pub}`).expect(403);
      await learnerA.post(`/api/learner/assessments/${pub}/attempt`).send({ answers: [] }).expect(403);
      await learnerB.get(`/api/learner/assessments/${pub}`).expect(404);
      await adminA.get('/api/learner/assessments').expect(403);

      // Lessons done, assessment not passed: no completion yet.
      await me.post(`/api/learner/lessons/${c.lessonIds[0]}/complete`).expect((r) => expect(r.status).toBeLessThan(300));
      expect(await dbQuery('SELECT id FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, c.id])).toHaveLength(0);

      // Attempt 1: half right = 50% < 60 -> fail.
      const fail = await me.post(`/api/learner/assessments/${pub}/attempt`).send({ answers: [{ question_id: q1.id, selected_option_id: opt(q1, 'Rome') }, { question_id: q2.id, selected_option_id: opt(q2, 'True') }] }).expect(200);
      expect(fail.body.result).toEqual(expect.objectContaining({ score: 1, total_questions: 2, percentage: 50, is_passed: false, passing_score: 60 }));
      expect(await dbQuery('SELECT id FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, c.id])).toHaveLength(0);

      // A foreign option id is discarded, not scored.
      const foreign = await me.post(`/api/learner/assessments/${pub}/attempt`).send({ answers: [{ question_id: q1.id, selected_option_id: opt(q2, 'True') }] }).expect(200);
      expect(foreign.body.result.score).toBe(0);

      // Attempt 3: all right -> pass, course completes.
      const pass = await me.post(`/api/learner/assessments/${pub}/attempt`).send({ answers: [{ question_id: q1.id, selected_option_id: opt(q1, 'Paris') }, { question_id: q2.id, selected_option_id: opt(q2, 'True') }] }).expect(200);
      expect(pass.body.result).toEqual(expect.objectContaining({ percentage: 100, is_passed: true }));
      expect(await dbQuery('SELECT id FROM certificates WHERE user_id = $1 AND course_id = $2', [p.id, c.id])).toHaveLength(1);

      // A later worse attempt does not lower the best score.
      await me.post(`/api/learner/assessments/${pub}/attempt`).send({ answers: [] }).expect(200);
      const after = await me.get('/api/learner/assessments').expect(200);
      expect(after.body.assessments.find((x: { id: number }) => x.id === a.id)).toEqual(expect.objectContaining({ attempt_count: 4, best_score: 100, has_passed: true, is_unlocked: true }));
      const attempts = await me.get(`/api/learner/assessments/${pub}/attempts`).expect(200);
      expect(attempts.body.attempts).toHaveLength(4);
      expect(Math.max(...attempts.body.attempts.map((t: { percentage: number }) => Number(t.percentage)))).toBe(100);
      // Another learner's attempt list is their own (empty).
      const theirs = await learnerA.get(`/api/learner/assessments/${pub}/attempts`).expect(200);
      expect(theirs.body.attempts).toEqual([]);

      // Points: completion 100 + early 75 + perfect score 200.
      const lb = await me.get('/api/learner/leaderboard').expect(200);
      expect(lb.body.me.allTimePoints).toBe(375);
    });

    it('a fill-in-the-blank question is answered with typed text and scored against the expected answer', async () => {
      // assessment-questions.ts: fillblank "The learner types the answer. Matched case-insensitively."
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      await assign(adminA, c.id, [p.id]);
      const { body: { assessment: a } } = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Blank' }).expect(201);
      const { body: { question } } = await adminA.post(`/api/admin/assessments/${a.id}/questions`).send({ question_text: 'Capital of Italy?', question_type: 'fillblank', correct_answer: 'Rome' }).expect(201);
      await adminA.post(`/api/admin/assessments/${a.id}/attach`).expect(200);
      const r = await me.post(`/api/learner/assessments/${a.id}/attempt`).send({ answers: [{ question_id: question.id, answer: 'rome' }] });
      expect(r.body.result).toEqual(expect.objectContaining({ total_questions: 1, percentage: 100, is_passed: true }));
    });

    it('multi-select is correct only when all and only the correct options are chosen', async () => {
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      await assign(adminA, c.id, [p.id]);
      const { body: { assessment: a } } = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Multi' }).expect(201);
      const { body: { question } } = await adminA.post(`/api/admin/assessments/${a.id}/questions`).send({ question_text: 'Primes', question_type: 'multiselect', options: [{ option_text: '2', is_correct: true }, { option_text: '3', is_correct: true }, { option_text: '4' }] }).expect(201);
      await adminA.post(`/api/admin/assessments/${a.id}/attach`).expect(200);
      const three = (question as Q).options.find((o) => o.option_text === '3')!.id;
      // Choosing only one of the two correct options must not count as correct.
      const r = await me.post(`/api/learner/assessments/${a.id}/attempt`).send({ answers: [{ question_id: question.id, selected_option_id: three }] });
      expect(r.body.result.is_passed).toBe(false);
    });

    it('scores a matching question only when every pair is matched, and never shows the learner the key', async () => {
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      await assign(adminA, c.id, [p.id]);
      const { body: { assessment: a } } = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Match' }).expect(201);
      const { body: { question } } = await adminA.post(`/api/admin/assessments/${a.id}/questions`).send({ question_text: 'Match capitals', question_type: 'matching', correct_answer: 'France = Paris\nItaly = Rome' }).expect(201);
      await adminA.post(`/api/admin/assessments/${a.id}/attach`).expect(200);

      const view = await me.get(`/api/learner/assessments/${a.id}`).expect(200);
      const q = view.body.questions[0];
      expect(q.correct_answer).toBeNull();
      expect(q.match_left).toEqual(['France', 'Italy']);
      expect([...q.match_right].sort()).toEqual(['Paris', 'Rome']);

      const half = await me.post(`/api/learner/assessments/${a.id}/attempt`).send({ answers: [{ question_id: question.id, pairs: [{ left: 'France', right: 'Rome' }, { left: 'Italy', right: 'Paris' }] }] }).expect(200);
      expect(half.body.result).toEqual(expect.objectContaining({ total_questions: 1, score: 0, is_passed: false }));
      const partial = await me.post(`/api/learner/assessments/${a.id}/attempt`).send({ answers: [{ question_id: question.id, pairs: [{ left: 'France', right: 'Paris' }] }] }).expect(200);
      expect(partial.body.result.is_passed).toBe(false);
      const all = await me.post(`/api/learner/assessments/${a.id}/attempt`).send({ answers: [{ question_id: question.id, pairs: [{ left: 'italy', right: ' rome ' }, { left: 'France', right: 'Paris' }] }] }).expect(200);
      expect(all.body.result).toEqual(expect.objectContaining({ score: 1, percentage: 100, is_passed: true }));
    });

    it('multi-select is correct when exactly the correct options are chosen', async () => {
      const c = await buildCourse(adminA);
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      await assign(adminA, c.id, [p.id]);
      const { body: { assessment: a } } = await adminA.post(`/api/admin/courses/${c.id}/assessments`).send({ title: 'Multi all' }).expect(201);
      const { body: { question } } = await adminA.post(`/api/admin/assessments/${a.id}/questions`).send({ question_text: 'Primes', question_type: 'multiselect', options: [{ option_text: '2', is_correct: true }, { option_text: '3', is_correct: true }, { option_text: '4' }] }).expect(201);
      await adminA.post(`/api/admin/assessments/${a.id}/attach`).expect(200);
      const id = (t: string) => (question as Q).options.find((o) => o.option_text === t)!.id;
      const extra = await me.post(`/api/learner/assessments/${a.id}/attempt`).send({ answers: [{ question_id: question.id, selected_option_ids: [id('2'), id('3'), id('4')] }] }).expect(200);
      expect(extra.body.result.is_passed).toBe(false);
      const exact = await me.post(`/api/learner/assessments/${a.id}/attempt`).send({ answers: [{ question_id: question.id, selected_option_ids: [id('3'), id('2')] }] }).expect(200);
      expect(exact.body.result).toEqual(expect.objectContaining({ score: 1, is_passed: true }));
    });
  });
});
