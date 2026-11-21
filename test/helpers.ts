/**
 * Test helpers for the API e2e suite.
 *
 *   const app = await createTestApp();
 *   const admin = await signIn(app, fx.A.admin);   // supertest agent with the cookie
 *   await admin.get('/api/admin/users').expect(200);
 *
 * `signIn` handles two-step sign-in with the fixture's TOTP secret, so admins
 * (for whom it is mandatory) behave exactly as in production.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';

export type Person = { id: number; email: string; password: string; totp?: string; firstName: string };
export type OrgFixture = {
  id: number;
  publicId: string;
  slug: string;
  admin: Person;
  manager: Person;
  learner: Person;
  learner2: Person;
  trainer: Person;
  roles: Record<string, number>;
};
export type Fixtures = { platform: { id: number; admin: Person }; A: OrgFixture; B: OrgFixture };

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const RUNTIME: string = require('./runtime-env').RUNTIME_DIR;

export function fixtures(): Fixtures {
  return JSON.parse(readFileSync(join(RUNTIME, 'fixtures.json'), 'utf8')) as Fixtures;
}

export type Agent = InstanceType<typeof TestAgent>;

/** Sign a fixture person in and return an agent that carries their cookie. */
export async function signIn(app: INestApplication, who: Pick<Person, 'email' | 'password' | 'totp'>): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/auth/login').send({ email: who.email, password: who.password });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`login failed for ${who.email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (res.body.mfa_required) {
    if (!who.totp) throw new Error(`${who.email} needs a second factor but the fixture has no TOTP secret`);
    const v = await agent.post('/api/auth/mfa/verify').send({ mfa_token: res.body.mfa_token, code: authenticator.generate(who.totp) });
    if (v.status >= 300) throw new Error(`mfa verify failed for ${who.email}: ${v.status} ${JSON.stringify(v.body)}`);
  }
  return agent;
}

/** An agent with no cookie. */
export function anon(app: INestApplication): Agent {
  return request.agent(app.getHttpServer());
}

/** Unique suffix for names created inside a test. */
export const uniq = (p = 'e2e') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Emails written by the file mail driver during the run (newest last). */
export function sentEmails(): { file: string; text: string }[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const dir = join(RUNTIME, 'storage', 'outbox');
  try {
    return readdirSync(dir)
      .map((f) => ({ file: f, at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at)
      .map((f) => ({ file: f.file, text: readFileSync(join(dir, f.file), 'utf8') }));
  } catch {
    return [];
  }
}

/** Direct read access to the e2e database, for asserting ground truth. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dbQuery<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/**
 * A throwaway person in an organization, created through the real admin API.
 * Use this whenever a test changes a password, role, two-step setting or
 * active flag, so the shared fixture accounts stay usable by other specs.
 */
export async function newPerson(adminAgent: Agent, org: OrgFixture, roleKey = 'learner', extra: Record<string, unknown> = {}): Promise<Person> {
  const first = `T${Math.random().toString(36).slice(2, 8)}`;
  const email = `${first.toLowerCase()}@${org.slug}.e2e.test`;
  const res = await adminAgent.post('/api/admin/users').send({ first_name: first, last_name: 'Temp', email, role_id: org.roles[roleKey], department: 'Engineering', ...extra });
  if (res.status >= 300) throw new Error(`newPerson ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const { hashPassword } = await import('@/common/crypto/password.util');
  const password = 'E2e-Passw0rd!';
  const [u] = await dbQuery<{ id: number }>('UPDATE users SET password = $2 WHERE email = $1 RETURNING id', [email, await hashPassword(password)]);
  return { id: u.id, email, password, firstName: first };
}

/** The newest outbox row for an address (the worker does not run in tests, so mail stays queued). */
export async function lastOutbox(toEmail: string, type?: string) {
  const rows = await dbQuery<{ type: string; subject: string; body: string; link: string | null; status: string }>(
    `SELECT type, subject, body, link, status FROM email_outbox WHERE to_email = $1 ${type ? 'AND type = $2' : ''} ORDER BY id DESC LIMIT 1`,
    type ? [toEmail, type] : [toEmail],
  );
  return rows[0];
}
