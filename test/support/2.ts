/**
 * Helpers for worker 2's specs (courses/content, media, assessments,
 * competencies).
 */
import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';

import { dbQuery, newPerson, signIn, uniq, type Agent, type OrgFixture, type Person } from '../helpers';

/** A real 1x1 PNG (valid signature + IHDR/IDAT/IEND). */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * An admin-portal person whose role holds ONLY `permissions`, signed in with
 * TOTP two-step sign-in enrolled. The role is written in SQL so creating it
 * does not bump the org's perm_version (which would sign everyone out).
 */
export async function limitedAdmin(app: INestApplication, orgAdmin: Agent, org: OrgFixture, permissions: string[]): Promise<{ agent: Agent; person: Person }> {
  const key = uniq('w2lim').replace(/-/g, '_');
  const [role] = await dbQuery<{ id: number }>(
    "INSERT INTO roles (organization_id, key, label, portal, scope, is_system) VALUES ($1, $2, $3, 'admin', 'org', false) RETURNING id",
    [org.id, key, `Limited ${key}`],
  );
  for (const p of permissions) await dbQuery('INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)', [role.id, p]);
  const person = await newPerson(orgAdmin, org, 'learner', { role_id: role.id });
  const agent = await signIn(app, person);
  const setup = await agent.post('/api/auth/mfa/setup').send({ method: 'totp' });
  if (setup.status >= 300) throw new Error(`mfa setup: ${setup.status} ${JSON.stringify(setup.body)}`);
  const en = await agent.post('/api/auth/mfa/enable').send({ code: authenticator.generate(setup.body.secret) });
  if (en.status >= 300) throw new Error(`mfa enable: ${en.status} ${JSON.stringify(en.body)}`);
  person.totp = setup.body.secret;
  return { agent, person };
}

export type BuiltCourse = { id: number; publicId: string; moduleId: number; lessonIds: number[]; name: string };

/**
 * A published course with one module and `lessons` link lessons (10 minutes
 * each), built through the real admin API.
 */
export async function buildCourse(admin: Agent, opts: { lessons?: number; name?: string; extra?: Record<string, unknown> } = {}): Promise<BuiltCourse> {
  const name = opts.name ?? uniq('Course');
  const c = await admin.post('/api/admin/courses').send({ name, category: 'Technical', ...(opts.extra ?? {}) });
  if (c.status >= 300) throw new Error(`course: ${c.status} ${JSON.stringify(c.body)}`);
  const id = c.body.course.id as number;
  const m = await admin.post(`/api/admin/courses/${id}/modules`).send({ title: 'Module 1' });
  if (m.status >= 300) throw new Error(`module: ${m.status} ${JSON.stringify(m.body)}`);
  const moduleId = m.body.module.id as number;
  const lessonIds: number[] = [];
  for (let i = 0; i < (opts.lessons ?? 1); i++) {
    const l = await admin.post(`/api/admin/modules/${moduleId}/lessons`).send({
      title: `Lesson ${i + 1}`, content_type: 'link', content_url: `https://example.test/l${i + 1}`, duration_minutes: 10,
    });
    if (l.status >= 300) throw new Error(`lesson: ${l.status} ${JSON.stringify(l.body)}`);
    lessonIds.push(l.body.lesson.id);
  }
  const [row] = await dbQuery<{ public_id: string }>('SELECT public_id FROM courses WHERE id = $1', [id]);
  return { id, publicId: row.public_id, moduleId, lessonIds, name };
}

/** Assign a course to users through the bulk route. */
export async function assign(admin: Agent, courseId: number, userIds: number[]): Promise<void> {
  const r = await admin.post(`/api/admin/courses/${courseId}/assignments/bulk`).send({ user_ids: userIds });
  if (r.status >= 300) throw new Error(`assign: ${r.status} ${JSON.stringify(r.body)}`);
}

/** Notifications of one type for one user. */
export function notificationsOf(userId: number, type: string) {
  return dbQuery<{ id: number; title: string }>('SELECT id, title FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id', [userId, type]);
}

/** Poll an async best-effort side effect (fire-and-forget notifications). */
export async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 20): Promise<T> {
  let v = await fn();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

export const ok = (r: { status: number }) => expect(r.status).toBeLessThan(400);
