/**
 * Content builders shared by worker 3's specs (sessions, journeys, catalogue,
 * certificates, external certifications, SCORM). Everything is created through
 * the real admin API with unique names, so specs never collide.
 */
import type { Agent, OrgFixture } from '../helpers';
import { dbQuery, uniq } from '../helpers';

export type CourseFx = { id: number; publicId: string; name: string; moduleId: number; lessonIds: number[] };

/** A published course with one module and `lessons` link lessons of 30 minutes each. */
export async function makeCourse(admin: Agent, opts: { lessons?: number; selfEnrol?: boolean; published?: boolean; name?: string } = {}): Promise<CourseFx> {
  const name = opts.name ?? uniq('Course');
  const c = await admin.post('/api/admin/courses').send({
    name,
    description: 'e2e course',
    category: 'Technical',
    is_active: opts.published ?? true,
    self_enrol: opts.selfEnrol ?? false,
  });
  if (c.status >= 300) throw new Error(`course: ${c.status} ${JSON.stringify(c.body)}`);
  const id = Number(c.body.course.id);
  const m = await admin.post(`/api/admin/courses/${id}/modules`).send({ title: 'Module 1' });
  if (m.status >= 300) throw new Error(`module: ${m.status} ${JSON.stringify(m.body)}`);
  const moduleId = Number(m.body.module.id);
  const lessonIds: number[] = [];
  for (let i = 0; i < (opts.lessons ?? 1); i++) {
    const l = await admin.post(`/api/admin/modules/${moduleId}/lessons`).send({
      title: `Lesson ${i + 1}`,
      content_type: 'link',
      content_url: 'https://example.test/lesson',
      duration_minutes: 30,
      sort_order: i,
    });
    if (l.status >= 300) throw new Error(`lesson: ${l.status} ${JSON.stringify(l.body)}`);
    lessonIds.push(Number(l.body.lesson.id));
  }
  const [row] = await dbQuery<{ public_id: string }>('SELECT public_id FROM courses WHERE id = $1', [id]);
  return { id, publicId: row.public_id, name, moduleId, lessonIds };
}

/** Assign a course directly to people. */
export async function assignCourse(admin: Agent, courseId: number, userIds: number[]) {
  const r = await admin.post(`/api/admin/courses/${courseId}/assignments/bulk`).send({ user_ids: userIds });
  if (r.status >= 300) throw new Error(`assign: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Complete every lesson of a course as the learner agent. */
export async function completeCourse(learner: Agent, course: CourseFx) {
  for (const l of course.lessonIds) {
    const r = await learner.post(`/api/learner/lessons/${l}/complete`);
    if (r.status >= 300) throw new Error(`complete lesson ${l}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

export type SessionInput = Partial<{
  title: string; session_type: 'ILT' | 'Virtual' | 'Webinar'; capacity: number; enroll_mode: 'assigned' | 'self';
  venue_url: string; date: string; end_date: string; start_time: string; end_time: string; status: string; trainer_user_id: number;
  dates: string[]; slots: { label?: string | null; start_time?: string | null; end_time?: string | null; capacity?: number | null }[];
}>;

/** The session body the form sends; a trainer account is required on create. */
export function sessionBody(org: OrgFixture, input: SessionInput = {}) {
  return {
    title: uniq('Session'),
    session_type: 'ILT',
    capacity: 10,
    trainer: 'ignored, derived from the account',
    trainer_user_id: org.trainer.id,
    venue_url: 'Room 1',
    date: '2030-01-15',
    start_time: '10:00',
    end_time: '12:00',
    enroll_mode: 'assigned',
    ...input,
  };
}

export async function makeSession(admin: Agent, org: OrgFixture, input: SessionInput = {}) {
  const body = sessionBody(org, input);
  const r = await admin.post('/api/admin/sessions').send(body);
  if (r.status >= 300) throw new Error(`session: ${r.status} ${JSON.stringify(r.body)}`);
  const id = Number(r.body.session.id);
  const [row] = await dbQuery<{ public_id: string; training_course_id: number }>(
    'SELECT s.public_id, c.id AS training_course_id FROM sessions s LEFT JOIN courses c ON c.session_id = s.id WHERE s.id = $1', [id]);
  return { id, publicId: row.public_id, trainingCourseId: Number(row.training_course_id), body, session: r.body.session };
}

/** Notifications written to a person, newest first. */
export async function notificationsOf(userId: number, type?: string) {
  return dbQuery<{ type: string; title: string; body: string | null; link: string | null }>(
    `SELECT type, title, body, link FROM notifications WHERE user_id = $1 ${type ? 'AND type = $2' : ''} ORDER BY id DESC`,
    type ? [userId, type] : [userId],
  );
}

/** Let fire-and-forget (void) notification writes land. */
export const settle = () => new Promise((r) => setTimeout(r, 300));

/** A tiny but valid PDF (the magic bytes are what the server sniffs). */
export const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
