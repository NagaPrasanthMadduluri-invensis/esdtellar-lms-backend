/**
 * Signing in and staying safe (CONTEXT.md §4): login, two-step sign-in by app
 * and by emailed code, consent, profile, password change / forgot / reset,
 * support sessions, logout, the retired register route.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { authenticator } from 'otplib';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, lastOutbox, newPerson, sentEmails, signIn, type Agent } from './helpers';

describe('auth', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
  });
  afterAll(async () => { await app.close(); });

  describe('login', () => {
    it('gives one indistinguishable 401 for a wrong password and an unknown email', async () => {
      const a = await anon(app).post('/api/auth/login').send({ email: fx.A.learner.email, password: 'nope-nope-1A!' });
      const b = await anon(app).post('/api/auth/login').send({ email: 'nobody@nowhere.test', password: 'nope-nope-1A!' });
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
      expect(a.body.message).toBe(b.body.message);
    });

    it('signs a learner in with an HttpOnly cookie and never returns the token in the body', async () => {
      const res = await anon(app).post('/api/auth/login').send({ email: fx.A.learner.email, password: fx.A.learner.password });
      expect(res.status).toBeLessThan(300);
      expect(String(res.headers['set-cookie'])).toMatch(/lms_token=.*HttpOnly/i);
      expect(JSON.stringify(res.body)).not.toMatch(/eyJ[a-zA-Z0-9_-]{10,}\./);
    });

    it('challenges an admin for the second factor and issues no cookie until it is verified', async () => {
      const agent = anon(app);
      const res = await agent.post('/api/auth/login').send({ email: fx.A.admin.email, password: fx.A.admin.password });
      expect(res.body.mfa_required).toBe(true);
      expect(res.headers['set-cookie']).toBeUndefined();
      await agent.get('/api/auth/me').expect(401);
      await agent.post('/api/auth/mfa/verify').send({ mfa_token: res.body.mfa_token, code: '000000' }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
      await agent.post('/api/auth/mfa/verify').send({ mfa_token: res.body.mfa_token, code: authenticator.generate(fx.A.admin.totp!) }).expect((r) => expect(r.status).toBeLessThan(300));
      await agent.get('/api/auth/me').expect(200);
    });

    it('refuses self-registration (retired)', async () => {
      const r = await anon(app).post('/api/auth/register').send({ email: 'x@y.test', password: 'Abcdef1!', first_name: 'X', last_name: 'Y' });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    it('logs out and the cookie stops working', async () => {
      const learner = await signIn(app, fx.A.learner2);
      await learner.get('/api/auth/me').expect(200);
      await learner.post('/api/auth/logout').expect((r) => expect(r.status).toBeLessThan(300));
      await learner.get('/api/auth/me').expect(401);
    });
  });

  describe('two-step sign-in', () => {
    it('an admin cannot turn it off; a learner can enrol by emailed code, sign in with a resent code, and turn it off', async () => {
      await adminA.post('/api/auth/mfa/disable').send({ code: authenticator.generate(fx.A.admin.totp!) }).expect(403);

      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      const status = await me.get('/api/auth/mfa/status').expect(200);
      expect(status.body).toEqual(expect.objectContaining({ enabled: false }));

      const before = sentEmails().length;
      await me.post('/api/auth/mfa/setup').send({ method: 'email' }).expect((r) => expect(r.status).toBeLessThan(300));
      const code = latestCode(before);
      await me.post('/api/auth/mfa/enable').send({ code }).expect((r) => expect(r.status).toBeLessThan(300));

      // Sign in again: challenged, ask for a fresh code, verify with it.
      const agent = anon(app);
      const login = await agent.post('/api/auth/login').send({ email: p.email, password: p.password });
      expect(login.body.mfa_required).toBe(true);
      expect(login.body.mfa_method).toBe('email');
      const n = sentEmails().length;
      await agent.post('/api/auth/mfa/resend').send({ mfa_token: login.body.mfa_token }).expect((r) => expect(r.status).toBeLessThan(300));
      await agent.post('/api/auth/mfa/verify').send({ mfa_token: login.body.mfa_token, code: latestCode(n) }).expect((r) => expect(r.status).toBeLessThan(300));

      // Turn it off with an emailed code.
      const m = sentEmails().length;
      await agent.post('/api/auth/mfa/email-code').expect((r) => expect(r.status).toBeLessThan(300));
      await agent.post('/api/auth/mfa/disable').send({ code: latestCode(m) }).expect((r) => expect(r.status).toBeLessThan(300));
      const after = await agent.get('/api/auth/mfa/status').expect(200);
      expect(after.body.enabled).toBe(false);
    });

    it('an exempt admin (MFA_EXEMPT_EMAILS) signs in on the password alone, even enrolled; other admins are still held', async () => {
      // Two new admins: one on the exempt list, one not. Both have email
      // two-step ON; the exempt one is never challenged.
      const make = async (email: string) => {
        await adminA.post('/api/admin/users').send({ first_name: 'Demo', last_name: 'Admin', email, role_id: fx.A.roles.admin }).expect((r) => expect(r.status).toBeLessThan(300));
        const { hashPassword } = await import('@/common/crypto/password.util');
        const [u] = await dbQuery<{ id: number }>('UPDATE users SET password = $2 WHERE email = $1 RETURNING id', [email, await hashPassword('E2e-Passw0rd!')]);
        return u.id;
      };
      const exemptId = await make('mfa-exempt@org-a-e2e.e2e.test');
      const heldId = await make(`mfa-held-${Date.now()}@org-a-e2e.e2e.test`);
      await dbQuery("INSERT INTO user_mfa (user_id, method, enabled_at) VALUES ($1, 'email', now()), ($2, 'email', now())", [exemptId, heldId]);

      const exempt = anon(app);
      const ok = await exempt.post('/api/auth/login').send({ email: 'MFA-EXEMPT@org-a-e2e.e2e.test', password: 'E2e-Passw0rd!' });
      expect(ok.status).toBeLessThan(300);
      expect(ok.body.mfa_required).toBeUndefined();
      expect(String(ok.headers['set-cookie'])).toMatch(/lms_token=/);
      const me = await exempt.get('/api/auth/me').expect(200);
      expect(me.body.user?.mfa_setup_required ?? me.body.mfa_setup_required).toBe(false);
      await exempt.get('/api/admin/community').expect(200);

      const [held] = await dbQuery<{ email: string }>('SELECT email FROM users WHERE id = $1', [heldId]);
      const challenged = await anon(app).post('/api/auth/login').send({ email: held.email, password: 'E2e-Passw0rd!' });
      expect(challenged.body.mfa_required).toBe(true);
      expect(challenged.headers['set-cookie']).toBeUndefined();
    });

    it('stores emailed codes only as hashes', async () => {
      const rows = await dbQuery("SELECT * FROM mfa_email_codes LIMIT 5");
      for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/"\d{6}"/);
    });
  });

  describe('consent and profile', () => {
    it('records the privacy acknowledgement and clears consent_required', async () => {
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      expect((await me.get('/api/auth/me')).body.user.consent_required).toBe(true);
      await me.post('/api/auth/consent').send({ leaderboard_visible: true, recognition_emails: true }).expect((r) => expect(r.status).toBeLessThan(300));
      expect((await me.get('/api/auth/me')).body.user.consent_required).toBe(false);
      const events = await dbQuery('SELECT event FROM consent_events WHERE user_id = $1', [p.id]);
      expect(events.map((e) => e.event)).toContain('acknowledged');
    });

    it('lets a person edit their own profile but not their email, department or role', async () => {
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      await me.get('/api/auth/profile').expect(200);
      await me.patch('/api/auth/profile').send({ phone: '+65 1234 5678', email: 'hijack@x.test', department: 'Finance', role_id: fx.A.roles.admin }).expect((r) => expect(r.status).toBeLessThan(300));
      const [row] = await dbQuery('SELECT email, department, role, phone FROM users WHERE id = $1', [p.id]);
      expect(row.phone).toBe('+65 1234 5678');
      expect(row.email).toBe(p.email);
      expect(row.department).toBe('Engineering');
      expect(row.role).toBe('learner');
    });
  });

  describe('passwords', () => {
    it('changes a password with the current one and refuses a weak one', async () => {
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      await me.post('/api/auth/change-password').send({ currentPassword: p.password, newPassword: 'weak' }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
      await me.post('/api/auth/change-password').send({ currentPassword: p.password, newPassword: 'N3w-Passw0rd!' }).expect((r) => expect(r.status).toBeLessThan(300));
      await signIn(app, { ...p, password: 'N3w-Passw0rd!' });
    });

    it('forgot-password answers the same for known and unknown addresses; the reset link sets a new password and ends sessions', async () => {
      const p = await newPerson(adminA, fx.A);
      const old = await signIn(app, p);
      const known = await anon(app).post('/api/auth/forgot-password').send({ email: p.email });
      const unknown = await anon(app).post('/api/auth/forgot-password').send({ email: 'ghost@nowhere.test' });
      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);

      const row = await lastOutbox(p.email);
      const token = decodeURIComponent(/token=([^&]+)/.exec(row.link ?? '')![1]);
      const check = await anon(app).get('/api/auth/reset-password/check').query({ token }).expect(200);
      expect(check.body).toEqual(expect.objectContaining({ valid: true }));
      await anon(app).post('/api/auth/reset-password').send({ token, newPassword: 'R3set-Passw0rd!' }).expect((r) => expect(r.status).toBeLessThan(300));
      await old.get('/api/auth/me').expect(401);
      await signIn(app, { ...p, password: 'R3set-Passw0rd!' });
      // A used token is refused.
      await anon(app).post('/api/auth/reset-password').send({ token, newPassword: 'An0ther-Passw0rd!' }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    });
  });

  describe('support session', () => {
    it('a platform admin enters an organization as its owner, cannot reach platform routes inside, and exits', async () => {
      const sa = await signIn(app, fx.platform.admin);
      await sa.post('/api/auth/impersonate').send({ organization_id: fx.A.id }).expect((r) => expect(r.status).toBeLessThan(300));
      const me = await sa.get('/api/auth/me').expect(200);
      expect(me.body.user.organization_id).toBe(fx.A.id);
      await sa.get('/api/platform/organizations').expect(403);
      await sa.post('/api/auth/exit-impersonation').expect((r) => expect(r.status).toBeLessThan(300));
      await sa.get('/api/platform/organizations').expect(200);
    });

    it('a tenant admin cannot open a support session', async () => {
      await adminA.post('/api/auth/impersonate').send({ organization_id: fx.B.id }).expect(403);
    });
  });
});

/** The 6-digit code in the newest email written after index `since`. */
function latestCode(since: number): string {
  const mails = sentEmails().slice(since).slice(-1);
  const text = mails.map((m) => m.text).join('\n').replace(/=\r?\n/g, '');
  // The first standalone 6-digit number that is not a #rrggbb colour.
  const codes = text.match(/(?<![#\w])\d{6}(?![\w])/g);
  if (!codes) throw new Error('no 6-digit code found in the emails sent');
  return codes[0];
}
