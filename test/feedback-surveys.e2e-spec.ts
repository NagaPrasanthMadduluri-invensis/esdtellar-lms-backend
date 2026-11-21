/**
 * Course feedback templates and answers (CONTEXT.md §10.24, 0034) and session
 * feedback (§10.20, 0032).
 *  - built-in templates can be edited, never deleted;
 *  - a course resolves its form from its category; submitting is an upsert (200);
 *  - learner-facing reviews show first name + last initial only;
 *  - session feedback only from attended learners of a completed session, and
 *    the trainer's read carries no names.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent, type Person } from './helpers';
import { limitedAdmin, makeCompletedSession, makeCourse, notificationsFor, waitFor, type CourseFx } from './support/4';

type Q = { id: number; question_type: string; options: string[] | null; is_required: boolean };

/** A valid answer for every question; `rating` sets the star. */
function answersFor(questions: Q[], rating: number, comment: string) {
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    if (q.question_type === 'rating') out[q.id] = rating;
    else if (q.question_type === 'likert') out[q.id] = 'Agree';
    else if (q.question_type === 'choice') out[q.id] = q.options![0];
    else if (q.question_type === 'yesno') out[q.id] = 'yes';
    else if (q.question_type === 'text') out[q.id] = comment;
  }
  return out;
}

describe('feedback and surveys', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
  });
  afterAll(async () => { await app.close(); });

  describe('admin templates', () => {
    it('lists the three built-in templates and creates, reads, edits and deletes a custom one', async () => {
      const list = await adminA.get('/api/admin/surveys/templates').expect(200);
      const keys = list.body.templates.filter((t: { is_system: boolean }) => t.is_system).map((t: { key: string }) => t.key).sort();
      expect(keys).toEqual(['compliance', 'standard', 'technical']);

      const name = uniq('Template');
      const created = await adminA.post('/api/admin/surveys/templates').send({
        name,
        description: 'Custom form',
        questions: [
          { question_type: 'rating', prompt: 'Overall?', is_required: true },
          { question_type: 'choice', prompt: 'Pace?', options: ['Slow', 'Right', 'Fast'] },
          { question_type: 'text', prompt: 'Anything else?', is_required: true },
        ],
      });
      expect(created.status).toBe(201);
      const t = created.body.template;
      expect(t).toEqual(expect.objectContaining({ name, is_system: false, question_count: 3 }));
      // An open text question is never required.
      expect(t.questions.find((q: Q) => q.question_type === 'text').is_required).toBe(false);

      const one = await adminA.get(`/api/admin/surveys/templates/${t.id}`).expect(200);
      expect(one.body.template.questions).toHaveLength(3);

      const edited = await adminA.patch(`/api/admin/surveys/templates/${t.id}`).send({
        name: `${name} v2`, is_active: false,
        questions: [{ question_type: 'yesno', prompt: 'Recommend?', is_required: false }],
      }).expect(200);
      expect(edited.body.template).toEqual(expect.objectContaining({ name: `${name} v2`, is_active: false, question_count: 1 }));

      // A choice question with fewer than two options is refused and writes nothing.
      const before = await dbQuery('SELECT COUNT(*)::int AS n FROM feedback_templates WHERE organization_id = $1', [fx.A.id]);
      await adminA.post('/api/admin/surveys/templates').send({ name: uniq('Bad'), questions: [{ question_type: 'choice', prompt: 'x', options: ['only'] }] }).expect(422);
      const after = await dbQuery('SELECT COUNT(*)::int AS n FROM feedback_templates WHERE organization_id = $1', [fx.A.id]);
      expect(after[0].n).toBe(before[0].n);

      const del = await adminA.delete(`/api/admin/surveys/templates/${t.id}`).expect(200);
      expect(del.body.ok).toBe(true);
      await adminA.get(`/api/admin/surveys/templates/${t.id}`).expect(404);
    });

    it('a built-in template cannot be deleted or switched off, but can be edited', async () => {
      const list = await adminA.get('/api/admin/surveys/templates').expect(200);
      const std = list.body.templates.find((t: { key: string }) => t.key === 'standard');
      const r = await adminA.delete(`/api/admin/surveys/templates/${std.id}`).expect(422);
      expect(r.body.message).toMatch(/cannot be deleted/);
      const full = await adminA.get(`/api/admin/surveys/templates/${std.id}`).expect(200);
      const p = await adminA.patch(`/api/admin/surveys/templates/${std.id}`).send({
        name: full.body.template.name, description: full.body.template.description, is_active: false,
      }).expect(200);
      expect(p.body.template.is_active).toBe(true);
    });

    it('is org-scoped and permission-guarded', async () => {
      const list = await adminA.get('/api/admin/surveys/templates').expect(200);
      const std = list.body.templates[0];
      await adminB.get(`/api/admin/surveys/templates/${std.id}`).expect(404);
      await adminB.delete(`/api/admin/surveys/templates/${std.id}`).expect(404);

      const { agent: noCourses } = await limitedAdmin(app, adminA, fx.A, ['view_reports']);
      await noCourses.get('/api/admin/surveys/templates').expect(403);
      await noCourses.get('/api/admin/surveys/responses').expect(403);
      const learner = await signIn(app, fx.A.learner2);
      await learner.get('/api/admin/surveys/options').expect(403);
    });
  });

  describe('course feedback', () => {
    let course: CourseFx;
    let alice: Person;
    let bob: Person;
    let aliceA: Agent;
    let bobA: Agent;

    beforeAll(async () => {
      alice = await newPerson(adminA, fx.A);
      bob = await newPerson(adminA, fx.A);
      course = await makeCourse(adminA, { assign: [alice.id, bob.id], category: 'Technical' });
      aliceA = await signIn(app, alice);
      bobA = await signIn(app, bob);
    });

    it('a Technical course resolves to the technical template (admin view and options)', async () => {
      const r = await adminA.get(`/api/admin/surveys/courses/${course.id}`).expect(200);
      expect(r.body.feedback_enabled).toBe(true);
      expect(r.body.resolved_template.key).toBe('technical');
      expect(r.body.override_template_id).toBeNull();
      await adminB.get(`/api/admin/surveys/courses/${course.id}`).expect(404);

      const o = await adminA.get('/api/admin/surveys/options').expect(200);
      expect(o.body.category_templates.Technical.key).toBe('technical');
      expect(o.body.default_template.key).toBe('standard');
    });

    it('finishing the course puts it in the learner\'s pending surveys; submitting moves it to submitted', async () => {
      const empty = await aliceA.get('/api/learner/surveys/pending').expect(200);
      expect(empty.body.surveys.map((s: { course_id: number }) => s.course_id)).not.toContain(course.id);

      await aliceA.post(`/api/learner/lessons/${course.lessons[0].publicId}/complete`).expect(200);
      const pending = await aliceA.get('/api/learner/surveys/pending').expect(200);
      expect(pending.body.surveys.map((s: { course_id: number }) => s.course_id)).toContain(course.id);

      const form = await aliceA.get(`/api/learner/courses/${course.publicId}/feedback`).expect(200);
      expect(form.body.feedback.my_answers).toBeNull();
      const qs: Q[] = form.body.feedback.questions;

      // A required question left blank is refused.
      await aliceA.post(`/api/learner/courses/${course.publicId}/feedback`).send({ answers: {} }).expect(422);
      // A rating outside 1..5 is refused.
      const bad = answersFor(qs, 9, 'x');
      await aliceA.post(`/api/learner/courses/${course.publicId}/feedback`).send({ answers: bad }).expect(422);

      const ok = await aliceA.post(`/api/learner/courses/${course.publicId}/feedback`)
        .send({ answers: { ...answersFor(qs, 4, 'Clear and useful'), 99999: 'smuggled' } }).expect(200);
      expect(ok.body).toEqual(expect.objectContaining({ ok: true, created: true }));
      const [row] = await dbQuery('SELECT answers FROM course_feedback WHERE course_id = $1 AND user_id = $2', [course.id, alice.id]);
      expect(row.answers).not.toHaveProperty('99999'); // whitelist of real questions only

      // The admins hear about the first submission.
      const n = await waitFor(async () => (await notificationsFor(fx.A.admin.id, 'course_feedback_received')).length > 0);
      expect(n).toBe(true);

      // Editing is an upsert: one row, created false, the new answer kept.
      const edit = await aliceA.post(`/api/learner/courses/${course.publicId}/feedback`).send({ answers: answersFor(qs, 5, 'Even better') }).expect(200);
      expect(edit.body.created).toBe(false);
      const rows = await dbQuery('SELECT answers FROM course_feedback WHERE course_id = $1 AND user_id = $2', [course.id, alice.id]);
      expect(rows).toHaveLength(1);
      const again = await aliceA.get(`/api/learner/courses/${course.publicId}/feedback`).expect(200);
      expect(Object.values(again.body.feedback.my_answers)).toContain('Even better');

      const inbox = await aliceA.get('/api/learner/surveys').expect(200);
      expect(inbox.body.pending.map((s: { course_id: number }) => s.course_id)).not.toContain(course.id);
      expect(inbox.body.submitted.map((s: { course_id: number }) => s.course_id)).toContain(course.id);
    });

    it('reviews show first name + last initial only, never a surname, email or user id', async () => {
      const form = await bobA.get(`/api/learner/courses/${course.publicId}/feedback`).expect(200);
      await bobA.post(`/api/learner/courses/${course.publicId}/feedback`).send({ answers: answersFor(form.body.feedback.questions, 3, 'Okay') }).expect(200);

      const r = await bobA.get(`/api/learner/courses/${course.publicId}/reviews`).expect(200);
      expect(r.body.count).toBe(2);
      expect(r.body.average).toBe(4); // (5 + 3) / 2
      expect(r.body.distribution).toEqual(expect.objectContaining({ '5': 1, '3': 1 }));
      const names = r.body.reviews.map((x: { name: string }) => x.name).sort();
      expect(names).toEqual([`${alice.firstName} T.`, `${bob.firstName} T.`].sort());
      const text = JSON.stringify(r.body);
      expect(text).not.toContain('Temp');
      expect(text).not.toContain(alice.email);
      expect(text).not.toMatch(/user_id/);
      for (const rev of r.body.reviews) expect(Object.keys(rev).sort()).toEqual(['comment', 'date', 'id', 'initials', 'name', 'rating']);
    });

    it('the admin reads the answers with full names; refusals for the unassigned and other orgs', async () => {
      const r = await adminA.get('/api/admin/surveys/responses').query({ course_id: course.id }).expect(200);
      expect(r.body.total).toBe(2);
      expect(r.body.responses.map((x: { learner_email: string }) => x.learner_email).sort()).toEqual([alice.email, bob.email].sort());
      expect(r.body.responses[0].answers.length).toBeGreaterThan(0);

      const outsider = await signIn(app, await newPerson(adminA, fx.A));
      await outsider.get(`/api/learner/courses/${course.publicId}/feedback`).expect(403);
      await outsider.post(`/api/learner/courses/${course.publicId}/feedback`).send({ answers: {} }).expect(403);
      await outsider.get(`/api/learner/courses/${course.publicId}/reviews`).expect(403);
      const b = await signIn(app, fx.B.learner);
      await b.get(`/api/learner/courses/${course.publicId}/reviews`).expect(404);

      const rb = await adminB.get('/api/admin/surveys/responses').query({ course_id: course.id }).expect(200);
      expect(rb.body.total).toBe(0);
    });
  });

  describe('session feedback', () => {
    let session: { id: number; title: string };
    const attendees: Person[] = [];
    let absent: Person;

    beforeAll(async () => {
      for (let i = 0; i < 3; i++) attendees.push(await newPerson(adminA, fx.A));
      absent = await newPerson(adminA, fx.A);
      session = await makeCompletedSession(adminA, fx.A.trainer.id, [
        ...attendees.map((p) => ({ user_id: p.id, status: 'present' })),
        { user_id: absent.id, status: 'absent' },
      ]);
    });

    it('lists the completed session for an attendee and accepts their ratings (200, upsert)', async () => {
      const me = await signIn(app, attendees[0]);
      const list = await me.get('/api/learner/feedback/sessions').expect(200);
      const s = list.body.sessions.find((x: { session_id: number }) => x.session_id === session.id);
      expect(s).toEqual(expect.objectContaining({ attendance: 'present', submitted: false }));
      expect(list.body.pending_count).toBeGreaterThanOrEqual(1);

      for (const [i, p] of attendees.entries()) {
        const a = await signIn(app, p);
        const r = await a.post(`/api/learner/feedback/sessions/${session.id}`).send({ rating_content: 4, rating_trainer: 5, rating_delivery: 3 + (i % 2), comment: `Session note ${i}` });
        expect(r.status).toBeLessThan(300);
        expect(r.body).toBeDefined();
      }
      // A revision keeps one row.
      await me.post(`/api/learner/feedback/sessions/${session.id}`).send({ rating_content: 5, rating_trainer: 5, rating_delivery: 5 }).expect((r) => expect(r.status).toBeLessThan(300));
      const rows = await dbQuery('SELECT user_id FROM session_feedback WHERE session_id = $1', [session.id]);
      expect(rows).toHaveLength(3);
      const after = await me.get('/api/learner/feedback/sessions').expect(200);
      expect(after.body.sessions.find((x: { session_id: number }) => x.session_id === session.id).submitted).toBe(true);
    });

    it('refuses a learner marked absent, one not on the roster (422), another org (404), and bad ratings', async () => {
      const ab = await signIn(app, absent);
      const r = await ab.post(`/api/learner/feedback/sessions/${session.id}`).send({ rating_content: 3, rating_trainer: 3, rating_delivery: 3 });
      expect(r.status).toBe(422);
      expect(r.body.message).toMatch(/absent/);

      // Same org but never on the roster: the session exists for them, attendance is unmarked (422).
      const stranger = await signIn(app, await newPerson(adminA, fx.A));
      const st = await stranger.post(`/api/learner/feedback/sessions/${session.id}`).send({ rating_content: 3, rating_trainer: 3, rating_delivery: 3 });
      expect(st.status).toBe(422);
      expect(st.body.message).toMatch(/not been marked/);
      const b = await signIn(app, fx.B.learner);
      await b.post(`/api/learner/feedback/sessions/${session.id}`).send({ rating_content: 3, rating_trainer: 3, rating_delivery: 3 }).expect(404);

      const me = await signIn(app, attendees[1]);
      await me.post(`/api/learner/feedback/sessions/${session.id}`).send({ rating_content: 9, rating_trainer: 3, rating_delivery: 3 }).expect(400);
    });

    // The controller docblock and CONTEXT.md §10.20: an upsert answers 200, not 201.
    it('session feedback submit returns 200 (upsert)', async () => {
      const me = await signIn(app, attendees[2]);
      await me.post(`/api/learner/feedback/sessions/${session.id}`).send({ rating_content: 4, rating_trainer: 5, rating_delivery: 4 }).expect(200);
    });

    it('the trainer reads averages (three responses) and comments with no learner names', async () => {
      const trainer = await signIn(app, fx.A.trainer);
      const r = await trainer.get('/api/trainer/feedback').query({ session_id: session.id }).expect(200);
      const text = JSON.stringify(r.body);
      for (const p of [...attendees, absent]) {
        expect(text).not.toContain(p.firstName);
        expect(text).not.toContain(p.email);
      }
      expect(text).not.toMatch(/"user_id"/);
      expect(r.body.summary.total_responses).toBeGreaterThanOrEqual(3);
      const card = (r.body.sessions ?? []).find((s: { session_id: number }) => s.session_id === session.id);
      expect(card).toEqual(expect.objectContaining({ sufficient: true, avg_trainer: 5 }));

      // The notification to the trainer is anonymous too.
      const n = await notificationsFor(fx.A.trainer.id, 'session_feedback_received');
      for (const row of n) expect(row.actor_name ?? '').toBe('');

      const learner = await signIn(app, fx.A.learner2);
      await learner.get('/api/trainer/feedback').expect(403);
      await adminA.get('/api/trainer/feedback').expect(403);
      // Org B's trainer sees nothing of org A's session.
      const tb = await signIn(app, fx.B.trainer);
      const rb = await tb.get('/api/trainer/feedback').expect(200);
      expect(JSON.stringify(rb.body)).not.toContain(session.title);
    });
  });
});
