/**
 * Helpers for worker 5's specs (community, notifications + email, my data,
 * retention). Kept out of helpers.ts on purpose.
 */
import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';

import { dbQuery, newPerson, signIn, uniq, type Agent, type OrgFixture, type Person } from '../helpers';

/** Poll a condition (fire-and-forget writes such as notify()) for up to ~3s. */
export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 30): Promise<T> {
  let v = await fn();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await fn();
  }
  return v;
}

/** Notifications of a type for a user, newest first. */
export function notificationsOf(userId: number, type: string) {
  return dbQuery<{ id: number; title: string; body: string; read_at: string | null; subject_id: number | null }>(
    'SELECT id, title, body, read_at, subject_id FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id DESC',
    [userId, type],
  );
}

/** Wait until a user has at least `n` notifications of a type. */
export function waitNotifications(userId: number, type: string, n = 1) {
  return waitFor(() => notificationsOf(userId, type), (rows) => rows.length >= n);
}

/**
 * An admin-portal person whose role holds ONLY the given permissions, signed
 * in with two-step sign-in enrolled. The role is written in SQL (not through
 * the roles API) because creating a role through the API bumps the
 * organization's perm_version and would sign every fixture person out.
 */
export async function limitedAdmin(
  app: INestApplication,
  adminAgent: Agent,
  org: OrgFixture,
  permissions: string[],
): Promise<{ person: Person; agent: Agent }> {
  const key = uniq('lim').replace(/-/g, '_');
  const [role] = await dbQuery<{ id: number }>(
    "INSERT INTO roles (organization_id, key, label, portal, scope, is_system) VALUES ($1,$2,$3,'admin','org',false) RETURNING id",
    [org.id, key, `Limited ${key}`],
  );
  for (const p of permissions) await dbQuery('INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)', [role.id, p]);
  const person = await newPerson(adminAgent, org, 'learner', { role_id: role.id });
  const agent = await signInEnrolling(app, person);
  return { person, agent };
}

/** Sign a person in and enrol TOTP if the server asks for it. */
export async function signInEnrolling(app: INestApplication, who: Person): Promise<Agent> {
  const agent = await signIn(app, who);
  const me = await agent.get('/api/auth/me');
  if (me.body?.user?.mfa_setup_required) {
    const setup = await agent.post('/api/auth/mfa/setup').send({ method: 'totp' });
    if (setup.status >= 300) throw new Error(`mfa setup: ${setup.status} ${JSON.stringify(setup.body)}`);
    who.totp = setup.body.secret;
    const en = await agent.post('/api/auth/mfa/enable').send({ code: authenticator.generate(who.totp!) });
    if (en.status >= 300) throw new Error(`mfa enable: ${en.status} ${JSON.stringify(en.body)}`);
  }
  return agent;
}

/** A hashtag-safe unique token (letters and digits only). */
export const tag = (p = 'Tag') => `${p}${Math.random().toString(36).slice(2, 8)}`;

/** The smallest byte string the shared-file sniffer accepts as a PDF. */
export const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n', 'ascii');
