/**
 * Direct messages (CONTEXT.md §10.42, 0054): send, thread, conversations,
 * unread count cleared by opening the thread, a bell-only notification, PDF
 * attachments readable only by sender and recipient, and another
 * organization's person indistinguishable from nobody (404).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent, type Person } from './helpers';
import { notificationsFor, TINY_PDF, waitFor } from './support/4';

const binary = (res: NodeJS.ReadableStream, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('direct messages', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let alice: Person;
  let bob: Person;
  let aliceA: Agent;
  let bobA: Agent;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    alice = await newPerson(adminA, fx.A);
    bob = await newPerson(adminA, fx.A);
    aliceA = await signIn(app, alice);
    bobA = await signIn(app, bob);
  });
  afterAll(async () => { await app.close(); });

  it('sends a message, rings the recipient\'s bell, and counts it unread until the thread is opened', async () => {
    const text = uniq('Hello');
    const sent = await aliceA.post(`/api/learner/messages/${bob.id}`).field('body', `  ${text}  `);
    expect(sent.status).toBe(201);
    expect(sent.body.message).toEqual(expect.objectContaining({ body: text, from_me: true, read: false, attachment: null }));

    const unread = await bobA.get('/api/learner/messages/unread').expect(200);
    expect(unread.body.count).toBe(1);

    const convs = await bobA.get('/api/learner/messages').expect(200);
    const c = convs.body.conversations.find((x: { user_id: number }) => x.user_id === alice.id);
    expect(c).toEqual(expect.objectContaining({ unread: 1, name: `${alice.firstName} T.` }));
    expect(c.last_message).toEqual(expect.objectContaining({ body: text, from_me: false }));

    const bell = await waitFor(async () => {
      const n = await notificationsFor(bob.id, 'direct_message');
      return n.length ? n : null;
    });
    expect(bell![0].link).toBe(`/messages?with=${alice.id}`);
    // Bell only: no email row for a DM.
    const mail = await dbQuery("SELECT 1 FROM email_outbox WHERE to_email = $1 AND type = 'direct_message'", [bob.email]);
    expect(mail).toHaveLength(0);

    const thread = await bobA.get(`/api/learner/messages/${alice.id}`).expect(200);
    expect(thread.body.peer).toEqual(expect.objectContaining({ user_id: alice.id, name: `${alice.firstName} T.` }));
    expect(thread.body.messages.map((m: { body: string }) => m.body)).toContain(text);
    expect(JSON.stringify(thread.body)).not.toContain(alice.email);

    expect((await bobA.get('/api/learner/messages/unread').expect(200)).body.count).toBe(0);
    // The sender now sees it as read.
    const mine = await aliceA.get(`/api/learner/messages/${bob.id}`).expect(200);
    expect(mine.body.messages.find((m: { body: string }) => m.body === text).read).toBe(true);
  });

  it('refuses an empty message, a message to yourself, and an over-long one', async () => {
    await aliceA.post(`/api/learner/messages/${bob.id}`).field('body', '   ').expect(400);
    await aliceA.post(`/api/learner/messages/${alice.id}`).field('body', 'me').expect(400);
    await aliceA.post(`/api/learner/messages/${bob.id}`).field('body', 'x'.repeat(10001)).expect(400);
  });

  it('a PDF attachment is readable by sender and recipient only', async () => {
    const sent = await aliceA.post(`/api/learner/messages/${bob.id}`).attach('file', TINY_PDF, { filename: 'notes.pdf', contentType: 'application/pdf' });
    expect(sent.status).toBe(201);
    expect(sent.body.message.body).toBe('');
    expect(sent.body.message.attachment).toEqual(expect.objectContaining({ name: 'notes.pdf', mime: 'application/pdf' }));
    expect(JSON.stringify(sent.body)).not.toMatch(/file_path/);
    const id = sent.body.message.id;

    for (const who of [aliceA, bobA]) {
      const f = await who.get(`/api/learner/messages/attachments/${id}/file`).buffer(true).parse(binary);
      expect(f.status).toBe(200);
      expect(f.headers['content-type']).toMatch(/application\/pdf/);
      expect(f.headers['content-disposition']).toMatch(/inline; filename="notes\.pdf"/);
      expect((f.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }

    const carol = await signIn(app, await newPerson(adminA, fx.A));
    await carol.get(`/api/learner/messages/attachments/${id}/file`).expect(403);
    const b = await signIn(app, fx.B.learner);
    await b.get(`/api/learner/messages/attachments/${id}/file`).expect(404);

    const conv = await bobA.get('/api/learner/messages').expect(200);
    const c = conv.body.conversations.find((x: { user_id: number }) => x.user_id === alice.id);
    expect(c.last_message).toEqual(expect.objectContaining({ body: 'notes.pdf', has_attachment: true }));
  });

  it('refuses a file whose bytes are not a PDF or image', async () => {
    const r = await aliceA.post(`/api/learner/messages/${bob.id}`).attach('file', Buffer.from('<html>not a pdf</html>'), { filename: 'evil.pdf', contentType: 'application/pdf' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('another organization\'s person, a missing person and an inactive one all 404', async () => {
    await aliceA.post(`/api/learner/messages/${fx.B.learner.id}`).field('body', 'hi').expect(404);
    await aliceA.get(`/api/learner/messages/${fx.B.learner.id}`).expect(404);
    await aliceA.get('/api/learner/messages/999999').expect(404);

    const gone = await newPerson(adminA, fx.A);
    await dbQuery('UPDATE users SET is_active = 0 WHERE id = $1', [gone.id]);
    await aliceA.post(`/api/learner/messages/${gone.id}`).field('body', 'hi').expect(404);

    // Org B sees none of org A's conversations.
    const b = await signIn(app, fx.B.learner);
    const convs = await b.get('/api/learner/messages').expect(200);
    expect(convs.body.conversations.map((c: { user_id: number }) => c.user_id)).not.toContain(alice.id);
  });

  it('is a learner-portal route', async () => {
    await adminA.get('/api/learner/messages').expect(403);
    const t = await signIn(app, fx.A.trainer);
    await t.get('/api/learner/messages/unread').expect(403);
  });
});
