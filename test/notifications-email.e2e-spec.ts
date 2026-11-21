/**
 * The bell and email (BACKEND_STRUCTURE §10.18, §10.30, §10.32): list, mark
 * read, mark all read; email preferences; the public HMAC unsubscribe link;
 * the tenant's own outbox and resend (failed rows only); the platform outbox;
 * and the SES events endpoint refusing an unsigned message.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createUnsubscribeToken } from '@/modules/email/unsubscribe-token';

import { createTestApp } from './app';
import { anon, dbQuery, fixtures, newPerson, signIn, type Agent } from './helpers';
import { limitedAdmin, tag, waitNotifications } from './support/5';

describe('notifications and email', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let superadmin: Agent;
  let learnerA: Agent;
  let readOnlyAdmin: Agent;

  const ok = (r: { status: number }) => expect(r.status).toBeLessThan(400);
  const secret = () => process.env.JWT_SECRET as string;
  const prefs = async (userId: number) =>
    (await dbQuery('SELECT all_off, groups_off FROM user_email_preferences WHERE user_id = $1', [userId]))[0];

  /** Make `count` community replies to a fresh person's post, so their bell has unread items. */
  async function bellWith(count: number) {
    const p = await newPerson(adminA, fx.A);
    const me = await signIn(app, p);
    const post = await me.post('/api/learner/community').send({ type: 'question', title: 'Bell test', hashtags: [tag()] }).expect(201);
    for (let i = 0; i < count; i++) {
      await learnerA.post(`/api/learner/community/${post.body.post.id}/replies`).send({ body: `reply ${i}` }).expect(201);
    }
    await waitNotifications(p.id, 'community_reply', count);
    return { p, me };
  }

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    superadmin = await signIn(app, fx.platform.admin);
    learnerA = await signIn(app, fx.A.learner);
    readOnlyAdmin = (await limitedAdmin(app, adminA, fx.A, ['view_employees'])).agent;
  });
  afterAll(async () => { await app.close(); });

  describe('the bell', () => {
    it('lists my own notifications with the unread count and derived is_read', async () => {
      const { p, me } = await bellWith(2);
      const r = await me.get('/api/notifications').query({ limit: 10 }).expect(200);
      const replies = r.body.notifications.filter((n: { type: string }) => n.type === 'community_reply');
      expect(replies).toHaveLength(2);
      expect(replies[0]).toEqual(expect.objectContaining({ is_read: false, group: expect.any(String), icon: expect.any(String) }));
      expect(r.body.unread_count).toBeGreaterThanOrEqual(2);
      expect(r.body.notifications.every((n: { user_id?: number }) => n.user_id === undefined || n.user_id === p.id)).toBe(true);
      await me.get('/api/notifications').query({ limit: 500 }).expect(400);
      await anon(app).get('/api/notifications').expect(401);
    });

    it('marks one read (only my own) and then all read', async () => {
      const { p, me } = await bellWith(2);
      const rows = await dbQuery('SELECT id FROM notifications WHERE user_id = $1 AND read_at IS NULL ORDER BY id', [p.id]);
      const unreadBefore = rows.length;

      // Somebody else cannot clear my notification: their call changes nothing of mine.
      await learnerA.post(`/api/notifications/${rows[0].id}/read`).expect(200);
      const [still] = await dbQuery('SELECT read_at FROM notifications WHERE id = $1', [rows[0].id]);
      expect(still.read_at).toBeNull();

      const one = await me.post(`/api/notifications/${rows[0].id}/read`).expect(200);
      expect(one.body.unread_count).toBe(unreadBefore - 1);
      const [now] = await dbQuery('SELECT read_at FROM notifications WHERE id = $1', [rows[0].id]);
      expect(now.read_at).not.toBeNull();
      await me.post('/api/notifications/abc/read').expect(400);

      const all = await me.post('/api/notifications/read').expect(200);
      expect(all.body).toEqual({ marked: unreadBefore - 1, unread_count: 0 });
      const left = await dbQuery('SELECT 1 FROM notifications WHERE user_id = $1 AND read_at IS NULL', [p.id]);
      expect(left).toHaveLength(0);
      const list = await me.get('/api/notifications').expect(200);
      expect(list.body.unread_count).toBe(0);
    });
  });

  describe('email preferences and unsubscribe', () => {
    it('reads defaults, saves a change, drops nothing it should keep and logs the change as consent history', async () => {
      const p = await newPerson(adminA, fx.A);
      const me = await signIn(app, p);
      const r = await me.get('/api/auth/email-preferences').expect(200);
      expect(r.body.preferences).toEqual({ all_off: false, groups_off: [] });
      expect(r.body.groups).toEqual(expect.arrayContaining(['learning', 'recognition']));

      const u = await me.patch('/api/auth/email-preferences').send({ groups_off: ['recognition', 'recognition', 'sessions'] }).expect(200);
      expect(u.body.preferences).toEqual({ all_off: false, groups_off: ['recognition', 'sessions'] });
      expect(await prefs(p.id)).toEqual({ all_off: 0, groups_off: 'recognition,sessions' });
      const ev = await dbQuery("SELECT source FROM consent_events WHERE user_id = $1 AND event = 'choice_changed'", [p.id]);
      expect(ev.map((e) => e.source)).toContain('email_preferences');

      // A no-op save writes no further consent row.
      await me.patch('/api/auth/email-preferences').send({ groups_off: ['sessions', 'recognition'] }).expect(200);
      expect(await dbQuery("SELECT 1 FROM consent_events WHERE user_id = $1 AND event = 'choice_changed'", [p.id])).toHaveLength(1);

      await me.patch('/api/auth/email-preferences').send({ groups_off: ['nonsense'] }).expect(400);
      await me.patch('/api/auth/email-preferences').send({ all_off: true }).expect(200);
      expect((await prefs(p.id)).all_off).toBe(1);
      await anon(app).get('/api/auth/email-preferences').expect(401);
    });

    it('a valid unsubscribe link works without signing in; an altered one changes nothing', async () => {
      const p = await newPerson(adminA, fx.A);
      const bad = await anon(app).get('/api/email/unsubscribe').query({ t: 'garbage.token' });
      expect(bad.status).toBe(400);
      expect(bad.text).toMatch(/did not work/);

      const forged = createUnsubscribeToken('not-the-real-secret-at-all-0000000000', p.id, 'all');
      await anon(app).get('/api/email/unsubscribe').query({ t: forged }).expect(400);
      expect(await prefs(p.id)).toBeUndefined();

      const good = await anon(app).get('/api/email/unsubscribe').query({ t: createUnsubscribeToken(secret(), p.id, 'all') }).expect(200);
      expect(good.headers['content-type']).toMatch(/html/);
      expect(good.text).toMatch(/You are unsubscribed/);
      expect(await prefs(p.id)).toEqual({ all_off: 1, groups_off: '' });
      const ev = await dbQuery("SELECT source FROM consent_events WHERE user_id = $1 AND event = 'choice_changed'", [p.id]);
      expect(ev.map((e) => e.source)).toEqual(['unsubscribe_link']);
    });

    it('the one-click POST always answers 200 and mutes only the token\'s group', async () => {
      const p = await newPerson(adminA, fx.A);
      const junk = await anon(app).post('/api/email/unsubscribe').query({ t: 'nope' }).expect(200);
      expect(junk.body).toEqual({ ok: true });
      expect(await prefs(p.id)).toBeUndefined();

      await anon(app).post('/api/email/unsubscribe').query({ t: createUnsubscribeToken(secret(), p.id, 'recognition') }).expect(200);
      expect(await prefs(p.id)).toEqual({ all_off: 0, groups_off: 'recognition' });
    });
  });

  describe('the tenant outbox', () => {
    it('lists only this organization\'s mail, filterable, with tiles from the same table', async () => {
      const p = await newPerson(adminA, fx.A);
      const r = await adminA.get('/api/admin/email/outbox').query({ q: p.email }).expect(200);
      expect(r.body.rows.length).toBeGreaterThanOrEqual(1);
      expect(r.body.rows.every((x: { to_email: string }) => x.to_email === p.email)).toBe(true);
      expect(r.body.counts).toEqual(expect.objectContaining({ pending: expect.any(Number) }));
      expect(Array.isArray(r.body.types)).toBe(true);

      const b = await adminB.get('/api/admin/email/outbox').query({ q: p.email }).expect(200);
      expect(b.body.rows).toHaveLength(0);
      await readOnlyAdmin.get('/api/admin/email/outbox').expect(200);
      await learnerA.get('/api/admin/email/outbox').expect(403);
      const lim = await limitedAdmin(app, adminA, fx.A, ['view_dashboard']);
      await lim.agent.get('/api/admin/email/outbox').expect(403);
    });

    it('resends a failed row only; a sent row is 422, another org 404, a viewer without manage_users 403', async () => {
      const p = await newPerson(adminA, fx.A);
      const [row] = await dbQuery('SELECT id FROM email_outbox WHERE to_email = $1 AND organization_id = $2 ORDER BY id DESC LIMIT 1', [p.email, fx.A.id]);
      await dbQuery("UPDATE email_outbox SET status = 'failed', attempts = 5, last_error = 'boom' WHERE id = $1", [row.id]);

      await readOnlyAdmin.post(`/api/admin/email/outbox/${row.id}/resend`).expect(403);
      await adminB.post(`/api/admin/email/outbox/${row.id}/resend`).expect(404);
      await adminA.post('/api/admin/email/outbox/999999999/resend').expect(404);

      const r = await adminA.post(`/api/admin/email/outbox/${row.id}/resend`).expect(200);
      expect(r.body).toEqual({ ok: true, id: row.id, to_email: p.email });
      const [after] = await dbQuery('SELECT status, attempts, last_error FROM email_outbox WHERE id = $1', [row.id]);
      expect(after).toEqual({ status: 'pending', attempts: 0, last_error: null });

      // Pending: refused, naming the state.
      const pend = await adminA.post(`/api/admin/email/outbox/${row.id}/resend`).expect(422);
      expect(pend.body.message).toMatch(/pending/);
      await dbQuery("UPDATE email_outbox SET status = 'sent' WHERE id = $1", [row.id]);
      const sent = await adminA.post(`/api/admin/email/outbox/${row.id}/resend`).expect(422);
      expect(sent.body.message).toMatch(/already sent/);
      await dbQuery("UPDATE email_outbox SET status = 'suppressed' WHERE id = $1", [row.id]);
      const sup = await adminA.post(`/api/admin/email/outbox/${row.id}/resend`).expect(422);
      expect(sup.body.message).toMatch(/withheld/);
      const [final] = await dbQuery('SELECT status FROM email_outbox WHERE id = $1', [row.id]);
      expect(final.status).toBe('suppressed');
    });
  });

  describe('the platform outbox', () => {
    it('spans every organization for a platform admin and is refused to a tenant admin', async () => {
      const pa = await newPerson(adminA, fx.A);
      const pb = await newPerson(adminB, fx.B);
      const r = await superadmin.get('/api/platform/email/outbox').query({ limit: 200 }).expect(200);
      const to = r.body.rows.map((x: { to_email: string }) => x.to_email);
      expect(to).toEqual(expect.arrayContaining([pa.email, pb.email]));
      expect(r.body.total).toBeGreaterThanOrEqual(2);
      const pending = await superadmin.get('/api/platform/email/outbox').query({ status: 'pending', limit: 5 }).expect(200);
      expect(pending.body.rows.every((x: { status: string }) => x.status === 'pending')).toBe(true);
      await superadmin.get('/api/platform/email/outbox').query({ status: 'bogus' }).expect(400);

      const s = await superadmin.get('/api/platform/email/outbox/summary').expect(200);
      expect(s.body.window_hours).toBe(24);
      expect(s.body.counts.pending).toBeGreaterThanOrEqual(2);

      await adminA.get('/api/platform/email/outbox').expect(403);
      await adminA.get('/api/platform/email/outbox/summary').expect(403);
    });
  });

  describe('SES events', () => {
    it('drops an unsigned bounce with 200 and suppresses nobody', async () => {
      const victim = fx.A.admin.email;
      const msg = { eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: victim }] }, mail: { messageId: 'x' } };
      const r = await anon(app).post('/api/email/ses-events').send({ Type: 'Notification', Message: JSON.stringify(msg) }).expect(200);
      expect(r.body).toEqual({ ok: true });
      // A certificate URL that is not Amazon's is refused before anything is fetched.
      await anon(app).post('/api/email/ses-events').send({
        Type: 'Notification', Message: JSON.stringify(msg), Signature: 'AAAA', SignatureVersion: '1', SigningCertURL: 'https://evil.example.com/cert.pem',
      }).expect(200);
      expect(await dbQuery('SELECT 1 FROM email_suppressions WHERE email = $1', [victim.toLowerCase()])).toHaveLength(0);
      ok(r);
    });
  });
});
