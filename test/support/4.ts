/**
 * Shared setup for worker 4's specs (progress, recognition, feedback,
 * engagement, AI, messages). Everything is created through the real admin API
 * except the limited-permission admin role, which is written in SQL so no
 * `perm_version` bump signs the organization's other agents out mid-file.
 */
import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';

import { dbQuery, newPerson, uniq, type Agent, type OrgFixture, type Person } from '../helpers';

export type CourseFx = { id: number; publicId: string; name: string; lessons: { id: number; publicId: string }[] };

/** A published course with one module of `link` lessons, assigned to `assign`. */
export async function makeCourse(
  admin: Agent,
  opts: { assign?: number[]; lessons?: number; category?: string; minutes?: number } = {},
): Promise<CourseFx> {
  const name = uniq('Course');
  const c = await admin.post('/api/admin/courses').send({ name, is_active: true, category: opts.category ?? 'Technical' });
  if (c.status >= 300) throw new Error(`course: ${c.status} ${JSON.stringify(c.body)}`);
  const id = c.body.course.id as number;
  const m = await admin.post(`/api/admin/courses/${id}/modules`).send({ title: 'Module 1' });
  if (m.status >= 300) throw new Error(`module: ${m.status} ${JSON.stringify(m.body)}`);
  const lessons: { id: number; publicId: string }[] = [];
  for (let i = 0; i < (opts.lessons ?? 1); i++) {
    const l = await admin.post(`/api/admin/modules/${m.body.module.id}/lessons`).send({
      title: `Lesson ${i + 1}`,
      content_type: 'link',
      content_url: 'https://example.com/read',
      duration_minutes: opts.minutes ?? 30,
    });
    if (l.status >= 300) throw new Error(`lesson: ${l.status} ${JSON.stringify(l.body)}`);
    lessons.push({ id: l.body.lesson.id, publicId: l.body.lesson.publicId });
  }
  if (opts.assign?.length) {
    const a = await admin.post(`/api/admin/courses/${id}/assignments/bulk`).send({ user_ids: opts.assign });
    if (a.status >= 300) throw new Error(`assign: ${a.status} ${JSON.stringify(a.body)}`);
  }
  const [row] = await dbQuery<{ public_id: string }>('SELECT public_id FROM courses WHERE id = $1', [id]);
  return { id, publicId: row.public_id, name, lessons };
}

/** A completed ILT session with `trainerId`, attendance as given. Returns its id. */
export async function makeCompletedSession(
  admin: Agent,
  trainerId: number,
  attendance: { user_id: number; status: string }[],
): Promise<{ id: number; title: string }> {
  const title = uniq('Session');
  const s = await admin.post('/api/admin/sessions').send({
    title, trainer: 'x', trainer_user_id: trainerId, venue_url: 'Room 1',
    date: '2026-11-02', start_time: '10:00', end_time: '11:00', session_type: 'ILT',
  });
  if (s.status >= 300) throw new Error(`session: ${s.status} ${JSON.stringify(s.body)}`);
  const id = s.body.session.id as number;
  for (const a of attendance) {
    const r = await admin.post(`/api/admin/sessions/${id}/roster`).send({ user_id: a.user_id });
    if (r.status >= 300) throw new Error(`roster: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const at = await admin.put(`/api/admin/sessions/${id}/attendance`).send({ records: attendance });
  if (at.status >= 300) throw new Error(`attendance: ${at.status} ${JSON.stringify(at.body)}`);
  const co = await admin.post(`/api/admin/sessions/${id}/complete`);
  if (co.status >= 300) throw new Error(`complete: ${co.status} ${JSON.stringify(co.body)}`);
  return { id, title };
}

/** Poll until `fn` returns a truthy value (for best-effort `void` writes). */
export async function waitFor<T>(fn: () => Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Sign an admin-portal person in, enrolling two-step sign-in (mandatory for admins). */
export async function signInAdmin(app: INestApplication, p: Person): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/auth/login').send({ email: p.email, password: p.password });
  if (res.status >= 300) throw new Error(`login ${p.email}: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.user?.mfa_setup_required) {
    const setup = await agent.post('/api/auth/mfa/setup').send({ method: 'totp' });
    if (setup.status >= 300) throw new Error(`mfa setup: ${setup.status} ${JSON.stringify(setup.body)}`);
    p.totp = setup.body.secret;
    const en = await agent.post('/api/auth/mfa/enable').send({ code: authenticator.generate(p.totp!) });
    if (en.status >= 300) throw new Error(`mfa enable: ${en.status} ${JSON.stringify(en.body)}`);
  }
  return agent;
}

/**
 * An admin-portal person whose role holds ONLY `permissions`, so a test can
 * prove a `@Permissions()` guard refuses an admin who lacks the one it names.
 */
export async function limitedAdmin(
  app: INestApplication,
  admin: Agent,
  org: OrgFixture,
  permissions: string[],
): Promise<{ agent: Agent; person: Person }> {
  const key = `e2e_${Math.random().toString(36).slice(2, 8)}`;
  const [role] = await dbQuery<{ id: number }>(
    "INSERT INTO roles (organization_id, key, label, portal, scope, is_system) VALUES ($1,$2,$3,'admin','org',false) RETURNING id",
    [org.id, key, `Limited ${key}`],
  );
  for (const p of permissions) await dbQuery('INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)', [role.id, p]);
  const person = await newPerson(admin, org, 'learner', { role_id: role.id });
  return { agent: await signInAdmin(app, person), person };
}

/** Notifications of `type` written for `userId`. */
export async function notificationsFor(userId: number, type: string) {
  return dbQuery<{ title: string; body: string | null; actor_name: string | null; link: string | null }>(
    'SELECT title, body, actor_name, link FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id',
    [userId, type],
  );
}

/** A tiny valid PDF (magic bytes are sniffed by the shared file store). */
export const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);
