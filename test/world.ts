/**
 * Runs once before the API e2e suite:
 *   1. starts (or reuses) the e2e Postgres and wipes it;
 *   2. writes the test runtime env and moves into test/runtime (the real
 *      server/.env is never read);
 *   3. starts the fake OpenRouter;
 *   4. boots the real app (migrations run) and builds the fixture world through
 *      the real API: the platform org, two tenant orgs A and B, and one person
 *      per role in each, with two-step sign-in enrolled for every admin.
 * The result is test/runtime/fixtures.json, read by every spec.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';

/* eslint-disable @typescript-eslint/no-require-imports */
// globalSetup runs outside Jest's module mapper, so register the `@/` alias
// for the app's own imports (src/**) before anything from src is loaded.
require('tsconfig-paths').register({ baseUrl: join(__dirname, '..'), paths: { '@/*': ['src/*'] } });
const db = require('./e2e-db');
const rt = require('./runtime-env');
const fakeAi = require('./fake-ai');

const PASSWORD = 'E2e-Passw0rd!';

/**
 * Prepares the e2e world: database, runtime env, fake AI, fixtures. Used by the
 * Jest globalSetup (API suite) and by web-api.ts (the Playwright journeys).
 * Returns the fake AI server so the caller can close it.
 */
export async function prepareWorld(): Promise<{ close: () => void }> {
  const url = await db.ensureUp();
  await db.reset();
  rt.writeRuntime(rt.runtimeEnv(url));
  rt.applyRuntime();
  for (const p of ['ai-requests.jsonl', 'storage', 'uploads', 'fixtures.json', 'visited.jsonl']) rmSync(join(rt.RUNTIME_DIR, p), { recursive: true, force: true });

  const aiServer = await fakeAi.start(rt.FAKE_AI_PORT);

  const superadmin = await bootstrapPlatform();
  const { createTestApp } = await import('./app');
  const app = await createTestApp();
  try {
    const fx = await buildFixtures(app, superadmin);
    writeFileSync(join(rt.RUNTIME_DIR, 'fixtures.json'), JSON.stringify(fx, null, 1));
    // Requests made while building fixtures are not tests: start coverage clean.
    rmSync(rt.COVERAGE_DIR, { recursive: true, force: true });
  } finally {
    await app.close();
  }
  return aiServer;
}

type P = { id: number; email: string; password: string; totp?: string; firstName: string };

async function buildFixtures(app: INestApplication, superadmin: P) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql = async (text: string, params: unknown[] = []): Promise<any[]> => (await pool.query(text, params)).rows;
  try {
    const { hashPassword } = await import('@/common/crypto/password.util');
    return await buildWorld(app, superadmin, sql, await hashPassword(PASSWORD));
  } finally {
    await pool.end();
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildWorld(app: INestApplication, superadmin: P, sql: (t: string, p?: unknown[]) => Promise<any[]>, hash: string) {
  // 1. The superadmin enrols two-step sign-in like any admin.
  const sa = await enrol(app, superadmin);

  // 2. Two tenant organizations, provisioned exactly as a platform admin would.
  const build = async (key: 'a' | 'b', name: string) => {
    const adminEmail = `admin@org-${key}.e2e.test`;
    const res = await sa.post('/api/platform/organizations').send({
      name,
      slug: `org-${key}-e2e`,
      // Large: every spec file creates throwaway learners here in one run. Seat-limit
      // behaviour is tested in throwaway orgs (users-seats.e2e-spec.ts).
      seatLimit: 5000,
      admin: { firstName: `Admin${key.toUpperCase()}`, lastName: 'Owner', email: adminEmail, password: PASSWORD },
    });
    if (res.status >= 300) throw new Error(`provision ${name}: ${res.status} ${JSON.stringify(res.body)}`);
    const [org] = await sql('SELECT id, public_id, slug FROM organizations WHERE slug = $1', [`org-${key}-e2e`]);
    const [adm] = await sql('SELECT id FROM users WHERE email = $1', [adminEmail]);
    const admin: P = { id: adm.id, email: adminEmail, password: PASSWORD, firstName: `Admin${key.toUpperCase()}` };
    const agent = await enrol(app, admin);

    await agent.post('/api/admin/roles/trainer').expect((r) => { if (r.status >= 300) throw new Error(`trainer role: ${r.status}`); });
    const roleRows = await sql('SELECT id, key FROM roles WHERE organization_id = $1', [org.id]);
    const roles = Object.fromEntries(roleRows.map((r: { key: string; id: number }) => [r.key, r.id]));

    const person = async (first: string, roleKey: string): Promise<P> => {
      const email = `${first.toLowerCase()}@org-${key}.e2e.test`;
      const r = await agent.post('/api/admin/users').send({ first_name: first, last_name: 'Tester', email, role_id: roles[roleKey], department: 'Engineering' });
      if (r.status >= 300) throw new Error(`create ${email}: ${r.status} ${JSON.stringify(r.body)}`);
      const [u] = await sql('UPDATE users SET password = $2 WHERE email = $1 RETURNING id', [email, hash]);
      return { id: u.id, email, password: PASSWORD, firstName: first };
    };
    const manager = await person('Manager', 'manager');
    const learner = await person('Learner', 'learner');
    const learner2 = await person('Learnertwo', 'learner');
    const trainer = await person('Trainer', 'trainer');
    await sql('UPDATE users SET manager_id = $1 WHERE id = ANY($2)', [manager.id, [learner.id, learner2.id]]);
    return { id: org.id, publicId: org.public_id, slug: org.slug, admin, manager, learner, learner2, trainer, roles };
  };

  const A = await build('a', 'Org A E2E');
  const B = await build('b', 'Org B E2E');
  const [platform] = await sql('SELECT id FROM organizations WHERE is_platform');
  return { platform: { id: platform.id, admin: superadmin }, A, B };
}

/** Sign in and, for an admin, enrol two-step sign-in with a TOTP secret kept on the person. */
async function enrol(app: INestApplication, who: P) {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/auth/login').send({ email: who.email, password: who.password });
  if (res.status >= 300) throw new Error(`login ${who.email}: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.user?.mfa_setup_required) {
    const setup = await agent.post('/api/auth/mfa/setup').send({ method: 'totp' });
    if (setup.status >= 300) throw new Error(`mfa setup ${who.email}: ${setup.status} ${JSON.stringify(setup.body)}`);
    who.totp = setup.body.secret;
    const en = await agent.post('/api/auth/mfa/enable').send({ code: authenticator.generate(who.totp!) });
    if (en.status >= 300) throw new Error(`mfa enable ${who.email}: ${en.status} ${JSON.stringify(en.body)}`);
  }
  return agent;
}

/**
 * The platform organization, its system roles and the superadmin, written in
 * SQL before the app boots (the app refuses to start without a platform org).
 * This is what scripts/migrate-tenancy.mjs + create-platform-admin do for a
 * real install.
 */
async function bootstrapPlatform(): Promise<P> {
  const { SYSTEM_ROLES } = await import('@/common/permissions');
  const { hashPassword } = await import('@/common/crypto/password.util');
  const { Client } = await import('pg');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    const { rows: [org] } = await c.query("INSERT INTO organizations (name, slug, is_platform) VALUES ('Edstellar Platform', 'platform', true) RETURNING id");
    let adminRoleId = 0;
    for (const r of SYSTEM_ROLES) {
      const { rows: [role] } = await c.query('INSERT INTO roles (organization_id, key, label, portal, scope, is_system) VALUES ($1,$2,$3,$4,$5,true) RETURNING id', [org.id, r.key, r.label, r.portal, r.scope]);
      for (const p of r.permissions) await c.query('INSERT INTO role_permissions (role_id, permission) VALUES ($1,$2)', [role.id, p]);
      if (r.key === 'admin') adminRoleId = role.id;
    }
    const email = 'superadmin@e2e.test';
    const { rows: [u] } = await c.query(
      "INSERT INTO users (first_name, last_name, email, password, role, organization_id, role_id) VALUES ('Super','Admin',$1,$2,'admin',$3,$4) RETURNING id",
      [email, await hashPassword(PASSWORD), org.id, adminRoleId],
    );
    await c.query('COMMIT');
    return { id: u.id, email, password: PASSWORD, firstName: 'Super' };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
