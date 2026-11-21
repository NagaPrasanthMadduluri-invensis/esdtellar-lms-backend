/**
 * Helpers for the reports / commercial / incidents / operations e2e specs.
 */
import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';

import { dbQuery, newPerson, signIn, uniq, type Agent, type OrgFixture, type Person } from '../helpers';

/** Poll until `fn` returns a truthy value (for best-effort writes made after the response). */
export async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 4000): Promise<T> {
  const started = Date.now();
  let last: T = await fn();
  while (!last && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    last = await fn();
  }
  return last;
}

/**
 * A published course with one module and one lesson, assigned to `userIds`.
 * Built through the real admin API.
 */
export async function makeCourse(admin: Agent, userIds: number[], name = uniq('Course')) {
  const c = await admin.post('/api/admin/courses').send({ name, description: 'e2e course', is_active: true, category: 'Technical' });
  if (c.status >= 300) throw new Error(`course: ${c.status} ${JSON.stringify(c.body)}`);
  const courseId: number = c.body.course.id;
  const m = await admin.post(`/api/admin/courses/${courseId}/modules`).send({ title: 'Module 1' });
  if (m.status >= 300) throw new Error(`module: ${m.status} ${JSON.stringify(m.body)}`);
  const moduleId: number = m.body.module.id;
  const l = await admin.post(`/api/admin/modules/${moduleId}/lessons`).send({
    title: 'Lesson 1', content_type: 'link', content_url: 'https://example.test/lesson', duration_minutes: 30,
  });
  if (l.status >= 300) throw new Error(`lesson: ${l.status} ${JSON.stringify(l.body)}`);
  if (userIds.length) {
    const a = await admin.post(`/api/admin/courses/${courseId}/assignments/bulk`).send({ user_ids: userIds });
    if (a.status >= 300) throw new Error(`assign: ${a.status} ${JSON.stringify(a.body)}`);
  }
  return { id: courseId, name, moduleId, lessonId: l.body.lesson.id as number };
}

/**
 * An admin-portal person whose role holds ONLY `permissions`, signed in with
 * two-step sign-in enrolled (mandatory for admins). The role is written in SQL
 * so creating it does not bump the org's perm_version (which would sign every
 * other agent in the org out).
 */
export async function limitedAdmin(app: INestApplication, orgAdmin: Agent, org: OrgFixture, permissions: string[]): Promise<{ agent: Agent; person: Person }> {
  const key = uniq('lim').replace(/-/g, '_');
  const [role] = await dbQuery<{ id: number }>(
    "INSERT INTO roles (organization_id, key, label, portal, scope, is_system) VALUES ($1, $2, $3, 'admin', 'org', false) RETURNING id",
    [org.id, key, `Limited ${key}`],
  );
  for (const p of permissions) await dbQuery('INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)', [role.id, p]);
  const person = await newPerson(orgAdmin, { ...org, roles: { ...org.roles, [key]: role.id } }, key);
  const agent = await signIn(app, person);
  const setup = await agent.post('/api/auth/mfa/setup').send({ method: 'totp' });
  if (setup.status >= 300) throw new Error(`mfa setup: ${setup.status} ${JSON.stringify(setup.body)}`);
  const en = await agent.post('/api/auth/mfa/enable').send({ code: authenticator.generate(setup.body.secret) });
  if (en.status >= 300) throw new Error(`mfa enable: ${en.status} ${JSON.stringify(en.body)}`);
  person.totp = setup.body.secret;
  return { agent, person };
}
