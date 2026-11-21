/**
 * Helpers for worker 1's specs (users/seats, roles, organizations, tenancy).
 *
 * `provisionOrg` builds a THROWAWAY organization through the real platform
 * API, so specs that bump `perm_version`, change a seat limit, replace the
 * workforce lists or switch access off never disturb the shared orgs A and B.
 */
import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';

import { dbQuery, uniq, type Agent, type OrgFixture, type Person } from '../helpers';

export const PASSWORD = 'E2e-Passw0rd!';

/** Sign in and enrol TOTP two-step sign-in when it is owed (an admin-portal person). */
export async function enrolSignIn(app: INestApplication, who: Person): Promise<Agent> {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/auth/login').send({ email: who.email, password: who.password });
  if (res.status >= 300) throw new Error(`login ${who.email}: ${res.status} ${JSON.stringify(res.body)}`);
  if (res.body.mfa_required) {
    const v = await agent.post('/api/auth/mfa/verify').send({ mfa_token: res.body.mfa_token, code: authenticator.generate(who.totp!) });
    if (v.status >= 300) throw new Error(`mfa verify ${who.email}: ${v.status}`);
    return agent;
  }
  if (res.body.user?.mfa_setup_required) {
    const setup = await agent.post('/api/auth/mfa/setup').send({ method: 'totp' });
    if (setup.status >= 300) throw new Error(`mfa setup ${who.email}: ${setup.status} ${JSON.stringify(setup.body)}`);
    who.totp = setup.body.secret;
    const en = await agent.post('/api/auth/mfa/enable').send({ code: authenticator.generate(who.totp!) });
    if (en.status >= 300) throw new Error(`mfa enable ${who.email}: ${en.status} ${JSON.stringify(en.body)}`);
  }
  return agent;
}

export type ThrowawayOrg = OrgFixture & { name: string; adminAgent: Agent };

/** Provision a fresh organization with an enrolled admin, as a platform admin would. */
export async function provisionOrg(app: INestApplication, platform: Agent, extra: Record<string, unknown> = {}): Promise<ThrowawayOrg> {
  const slug = uniq('t').toLowerCase();
  const name = `Throwaway ${slug}`;
  const adminEmail = `admin@${slug}.e2e.test`;
  const res = await platform.post('/api/platform/organizations').send({
    name,
    slug,
    seatLimit: 50,
    admin: { firstName: 'Tadmin', lastName: 'Owner', email: adminEmail, password: PASSWORD },
    ...extra,
  });
  if (res.status >= 300) throw new Error(`provision ${slug}: ${res.status} ${JSON.stringify(res.body)}`);
  const [org] = await dbQuery('SELECT id, public_id, slug FROM organizations WHERE slug = $1', [slug]);
  const [adm] = await dbQuery('SELECT id FROM users WHERE email = $1', [adminEmail]);
  const admin: Person = { id: adm.id, email: adminEmail, password: PASSWORD, firstName: 'Tadmin' };
  const adminAgent = await enrolSignIn(app, admin);
  const roleRows = await dbQuery<{ id: number; key: string }>('SELECT id, key FROM roles WHERE organization_id = $1', [org.id]);
  const roles = Object.fromEntries(roleRows.map((r) => [r.key, r.id]));
  const none = undefined as unknown as Person;
  return { id: org.id, publicId: org.public_id, slug: org.slug, name, admin, adminAgent, roles, manager: none, learner: none, learner2: none, trainer: none };
}

/** Number of email_outbox rows for an organization. */
export async function outboxCount(orgId: number): Promise<number> {
  const [r] = await dbQuery<{ n: number }>('SELECT COUNT(*)::int AS n FROM email_outbox WHERE organization_id = $1', [orgId]);
  return r.n;
}

export const ok = (r: { status: number }) => expect(r.status).toBeLessThan(400);
