/**
 * Learning Community (CONTEXT.md / BACKEND_STRUCTURE §10.35, §10.40-§10.42):
 * post types, the admin-only discussion, required + normalised hashtags,
 * trending, groups, likes, replies, moderation, resources, kudos and the
 * organization's on/off switch.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';

import { createTestApp } from './app';
import { dbQuery, fixtures, newPerson, signIn, uniq, type Agent } from './helpers';
import { limitedAdmin, notificationsOf, tag, TINY_PDF, waitNotifications } from './support/5';

describe('community', () => {
  let app: NestExpressApplication;
  const fx = fixtures();
  let adminA: Agent;
  let adminB: Agent;
  let learner: Agent;
  let learner2: Agent;
  let learnerB: Agent;
  let manager: Agent;
  let noModerator: Agent;

  const ok = (r: { status: number }) => expect(r.status).toBeLessThan(400);

  async function question(agent: Agent, hashtags: string[] = [tag()], extra: Record<string, unknown> = {}) {
    const r = await agent.post('/api/learner/community').send({ type: 'question', title: uniq('Q'), body: 'How?', hashtags, ...extra });
    expect(r.status).toBe(201);
    return r.body.post as { id: string; hashtags: { tag: string; label: string }[]; type: string };
  }
  const pk = async (publicId: string) => (await dbQuery('SELECT id FROM community_posts WHERE public_id = $1', [publicId]))[0].id as number;

  beforeAll(async () => {
    app = await createTestApp();
    adminA = await signIn(app, fx.A.admin);
    adminB = await signIn(app, fx.B.admin);
    learner = await signIn(app, fx.A.learner);
    learner2 = await signIn(app, fx.A.learner2);
    learnerB = await signIn(app, fx.B.learner);
    manager = await signIn(app, fx.A.manager);
    // An admin-portal role WITHOUT moderate_community.
    noModerator = (await limitedAdmin(app, adminA, fx.A, ['view_employees'])).agent;
  });
  afterAll(async () => { await app.close(); });

  describe('posts and hashtags', () => {
    it('normalises hashtags: case, a leading # and spaces collapse to one stored tag, and inline #tokens are merged', async () => {
      const base = tag('Renew');
      const inline = tag('Inline');
      const post = await question(learner, [`#${base}`, ` ${base.toLowerCase()} `, base.toUpperCase()], { body: `Body with #${inline}` });
      expect(post.type).toBe('question');
      expect(post.hashtags).toEqual(expect.arrayContaining([
        { tag: base.toLowerCase(), label: base },
        { tag: inline.toLowerCase(), label: inline },
      ]));
      expect(post.hashtags).toHaveLength(2);
      const rows = await dbQuery('SELECT tag, label FROM community_hashtags WHERE organization_id = $1 AND tag = $2', [fx.A.id, base.toLowerCase()]);
      expect(rows).toEqual([{ tag: base.toLowerCase(), label: base }]);

      // Feed filter by a differently-cased tag finds it.
      const feed = await learner.get('/api/learner/community').query({ hashtag: `#${base.toUpperCase()}` }).expect(200);
      expect(feed.body.posts.map((p: { id: string }) => p.id)).toEqual([post.id]);
    });

    it('requires at least one hashtag and a title on a question', async () => {
      const none = await learner.post('/api/learner/community').send({ type: 'question', title: uniq('Q'), hashtags: [] });
      expect(none.status).toBe(400);
      expect(none.body.message).toMatch(/hashtag/i);
      const junk = await learner.post('/api/learner/community').send({ type: 'question', title: uniq('Q'), hashtags: ['###', '  '] });
      expect(junk.status).toBe(400);
      await learner.post('/api/learner/community').send({ type: 'question', hashtags: [tag()] }).expect(400);
      await learner.post('/api/learner/community').send({ type: 'poll', title: 'x', hashtags: [tag()] }).expect(400);
    });

    it('refuses a learner starting a discussion (403); an admin starts one (201) and the learner can reply', async () => {
      const r = await learner.post('/api/learner/community').send({ type: 'discussion', title: uniq('D'), hashtags: [tag()] });
      expect(r.status).toBe(403);

      await adminA.post('/api/admin/community/discussions').send({ title: uniq('D') }).expect(400);
      const d = await adminA.post('/api/admin/community/discussions').send({ title: uniq('D'), body: 'Talk', hashtags: [tag()] }).expect(201);
      expect(d.body.post.type).toBe('discussion');
      await learner.post(`/api/learner/community/${d.body.post.id}/replies`).send({ body: 'My view' }).expect(201);

      // A learner-portal account and an admin without moderate_community cannot.
      await manager.post('/api/admin/community/discussions').send({ title: uniq('D'), hashtags: [tag()] }).expect(403);
      await noModerator.post('/api/admin/community/discussions').send({ title: uniq('D'), hashtags: [tag()] }).expect(403);
    });

    it('shares an achievement from the learner\'s own certificate, capturing the course name', async () => {
      const name = uniq('Cert Course');
      await adminA.post('/api/admin/courses').send({ name, is_active: true, category: 'Technical' }).expect((x) => ok(x));
      const [course] = await dbQuery('SELECT id FROM courses WHERE name = $1', [name]);
      const [cert] = await dbQuery(
        'INSERT INTO certificates (organization_id, user_id, course_id, certificate_code, issued_at) VALUES ($1,$2,$3,$4,now()) RETURNING id',
        [fx.A.id, fx.A.learner.id, course.id, `E2E${Date.now().toString(36).toUpperCase()}`],
      );
      await learner.post('/api/learner/community').send({ type: 'achievement', hashtags: [tag()] }).expect(400);
      // Somebody else's certificate is not found.
      await learner2.post('/api/learner/community').send({ type: 'achievement', certificateId: cert.id, hashtags: [tag()] }).expect(404);
      const a = await learner.post('/api/learner/community').send({ type: 'achievement', certificateId: cert.id, hashtags: [tag()] }).expect(201);
      expect(a.body.post.type).toBe('achievement');
      expect(a.body.post.title).toBe(name);
      expect(a.body.post.certificate).toEqual(expect.objectContaining({ revoked: false }));
      const feed = await learner2.get('/api/learner/community').query({ type: 'achievement' }).expect(200);
      expect(feed.body.posts.every((p: { type: string }) => p.type === 'achievement')).toBe(true);
      expect(feed.body.posts.map((p: { id: string }) => p.id)).toContain(a.body.post.id);
    });

    it('keeps posts inside the organization: org B neither sees nor opens org A posts', async () => {
      const post = await question(learner);
      const feedB = await learnerB.get('/api/learner/community').query({ limit: 50 }).expect(200);
      expect(feedB.body.posts.map((p: { id: string }) => p.id)).not.toContain(post.id);
      await learnerB.get(`/api/learner/community/${post.id}`).expect(404);
      await adminB.get(`/api/admin/community/${post.id}`).expect(404);
      const detail = await learner2.get(`/api/learner/community/${post.id}`).expect(200);
      expect(detail.body.post.author.name).toBe('Learner T.');
      expect(detail.body.post.isMine).toBe(false);
    });

    it('trends a tag used on live posts and suggests it by prefix; a removed post drops out of trending', async () => {
      const t = tag('Trend');
      const p1 = await question(learner, [t]);
      await question(learner2, [t]);
      const trending = await learner.get('/api/learner/community/hashtags/trending').expect(200);
      const row = trending.body.hashtags.find((h: { tag: string }) => h.tag === t.toLowerCase());
      expect(row).toEqual(expect.objectContaining({ label: t, count: 2 }));

      const suggest = await learner.get('/api/learner/community/hashtags').query({ q: `#${t.slice(0, 7)}` }).expect(200);
      expect(suggest.body.hashtags.map((h: { tag: string }) => h.tag)).toContain(t.toLowerCase());
      const empty = await learner.get('/api/learner/community/hashtags').query({ q: '#' }).expect(200);
      expect(empty.body.hashtags).toEqual([]);

      await learner.delete(`/api/learner/community/${p1.id}`).expect(200);
      const after = await learner.get('/api/learner/community/hashtags/trending').expect(200);
      expect(after.body.hashtags.find((h: { tag: string }) => h.tag === t.toLowerCase())?.count).toBe(1);
      // Org B never sees org A's tag.
      const b = await learnerB.get('/api/learner/community/hashtags/trending').expect(200);
      expect(b.body.hashtags.map((h: { tag: string }) => h.tag)).not.toContain(t.toLowerCase());
    });
  });

  describe('likes and replies', () => {
    it('likes idempotently, lists who liked as first name + last initial, and unlikes', async () => {
      const post = await question(learner);
      const l1 = await learner2.post(`/api/learner/community/${post.id}/like`).expect(200);
      expect(l1.body).toEqual({ liked: true, likeCount: 1 });
      const l2 = await learner2.post(`/api/learner/community/${post.id}/like`).expect(200);
      expect(l2.body.likeCount).toBe(1);
      await learner.post(`/api/learner/community/${post.id}/like`).expect(200);

      const likers = await learner.get(`/api/learner/community/${post.id}/likes`).expect(200);
      const names = likers.body.likers.map((x: { name: string }) => x.name);
      expect(names).toEqual(expect.arrayContaining(['Learnertwo T.', 'Learner T.']));
      expect(likers.body.likers.find((x: { is_me: boolean }) => x.is_me).user_id).toBe(fx.A.learner.id);
      expect(JSON.stringify(likers.body)).not.toMatch(/Tester/);

      const u = await learner2.delete(`/api/learner/community/${post.id}/like`).expect(200);
      expect(u.body).toEqual({ liked: false, likeCount: 1 });
      const [row] = await dbQuery('SELECT like_count FROM community_posts WHERE public_id = $1', [post.id]);
      expect(row.like_count).toBe(1);

      await learnerB.post(`/api/learner/community/${post.id}/like`).expect(404);
      await learnerB.get(`/api/learner/community/${post.id}/likes`).expect(404);
    });

    it('a reply notifies the author (not a self-reply); only the reply author deletes it', async () => {
      const post = await question(learner);
      const id = await pk(post.id);
      const before = (await notificationsOf(fx.A.learner.id, 'community_reply')).length;

      const r = await learner2.post(`/api/learner/community/${post.id}/replies`).send({ body: 'Try this' }).expect(201);
      expect(r.body.reply).toEqual(expect.objectContaining({ body: 'Try this', isMine: true }));
      const rows = await waitNotifications(fx.A.learner.id, 'community_reply', before + 1);
      expect(rows[0].subject_id).toBe(id);
      expect(rows[0].title).toBe('New contribution to your question');

      await learner.post(`/api/learner/community/${post.id}/replies`).send({ body: 'Thanks' }).expect(201);
      await learner.post(`/api/learner/community/${post.id}/replies`).send({ body: '   ' }).expect(400);
      await new Promise((res) => setTimeout(res, 300));
      expect((await notificationsOf(fx.A.learner.id, 'community_reply')).length).toBe(before + 1);

      const detail = await learner.get(`/api/learner/community/${post.id}`).expect(200);
      expect(detail.body.post.replyCount).toBe(2);
      expect(detail.body.replies).toHaveLength(2);

      await learner.delete(`/api/learner/community/replies/${r.body.reply.id}`).expect(403);
      await learnerB.delete(`/api/learner/community/replies/${r.body.reply.id}`).expect(404);
      await learner2.delete(`/api/learner/community/replies/${r.body.reply.id}`).expect(200);
      const [p] = await dbQuery('SELECT reply_count FROM community_posts WHERE id = $1', [id]);
      expect(p.reply_count).toBe(1);
      await learnerB.post(`/api/learner/community/${post.id}/replies`).send({ body: 'x' }).expect(404);
    });

    it('only the author deletes their own post, and a deleted post is gone', async () => {
      const post = await question(learner);
      await learner2.delete(`/api/learner/community/${post.id}`).expect(403);
      await learner.delete(`/api/learner/community/${post.id}`).expect(200);
      await learner.get(`/api/learner/community/${post.id}`).expect(404);
      const [row] = await dbQuery('SELECT deleted_at, deleted_by FROM community_posts WHERE public_id = $1', [post.id]);
      expect(row.deleted_at).not.toBeNull();
      expect(row.deleted_by).toBe(fx.A.learner.id);
    });
  });

  describe('moderation', () => {
    it('admin reads the full feed with full names; a learner cannot reach it', async () => {
      const post = await question(learner);
      const list = await adminA.get('/api/admin/community').query({ type: 'question', limit: 50 }).expect(200);
      expect(list.body.total).toBeGreaterThan(0);
      const mine = list.body.posts.find((p: { id: string }) => p.id === post.id);
      expect(mine.author).toEqual(expect.objectContaining({ name: 'Learner Tester', email: fx.A.learner.email }));
      const detail = await adminA.get(`/api/admin/community/${post.id}`).expect(200);
      expect(detail.body.post.id).toBe(post.id);
      // A non-moderating admin may READ.
      await noModerator.get('/api/admin/community').expect(200);
      await learner.get('/api/admin/community').expect(403);
      const listB = await adminB.get('/api/admin/community').query({ limit: 50 }).expect(200);
      expect(listB.body.posts.map((p: { id: string }) => p.id)).not.toContain(post.id);
    });

    it('a moderator removal hides the post and tells the author; it needs moderate_community', async () => {
      const post = await question(learner);
      await noModerator.delete(`/api/admin/community/${post.id}`).expect(403);
      await adminB.delete(`/api/admin/community/${post.id}`).expect(404);
      const before = (await notificationsOf(fx.A.learner.id, 'community_post_removed')).length;
      await adminA.delete(`/api/admin/community/${post.id}`).expect(200);
      const rows = await waitNotifications(fx.A.learner.id, 'community_post_removed', before + 1);
      expect(rows[0].body).toMatch(/moderator/i);
      expect(rows[0].body).not.toMatch(/Admin/);
      await learner.get(`/api/learner/community/${post.id}`).expect(404);
    });

    it('a moderator removes a reply; a non-moderator cannot', async () => {
      const post = await question(learner);
      const r = await learner2.post(`/api/learner/community/${post.id}/replies`).send({ body: 'Off topic' }).expect(201);
      await noModerator.delete(`/api/admin/community/replies/${r.body.reply.id}`).expect(403);
      await adminB.delete(`/api/admin/community/replies/${r.body.reply.id}`).expect(404);
      await adminA.delete(`/api/admin/community/replies/${r.body.reply.id}`).expect(200);
      const [row] = await dbQuery('SELECT deleted_at FROM community_replies WHERE id = $1', [r.body.reply.id]);
      expect(row.deleted_at).not.toBeNull();
      const detail = await learner.get(`/api/learner/community/${post.id}`).expect(200);
      expect(detail.body.replies).toHaveLength(0);
    });
  });

  describe('groups', () => {
    it('admin creates a group; a learner must join to post, anyone in the org can read; leave and archive', async () => {
      await noModerator.post('/api/admin/community/groups').send({ name: uniq('G') }).expect(403);
      await learner.post('/api/admin/community/groups').send({ name: uniq('G') }).expect(403);
      const name = uniq('Group');
      const g = await adminA.post('/api/admin/community/groups').send({ name, description: 'Solar folk' }).expect(201);
      expect(g.body.group).toEqual(expect.objectContaining({ name, archived: false, memberCount: 0 }));
      const intId = g.body.group.id as number;
      expect(typeof intId).toBe('number');

      const list = await learner.get('/api/learner/community/groups').expect(200);
      const lg = list.body.groups.find((x: { name: string }) => x.name === name);
      expect(lg.joined).toBe(false);
      const pub = lg.id as string;
      expect(pub).toMatch(/^[0-9a-f-]{36}$/);
      const listB = await learnerB.get('/api/learner/community/groups').expect(200);
      expect(listB.body.groups.map((x: { name: string }) => x.name)).not.toContain(name);

      await learner.post('/api/learner/community').send({ type: 'question', title: uniq('Q'), hashtags: [tag()], groupId: pub }).expect(403);
      const j = await learner.post(`/api/learner/community/groups/${pub}/join`).expect(200);
      expect(j.body).toEqual({ joined: true });
      await learner.post(`/api/learner/community/groups/${pub}/join`).expect(200);
      const gp = await question(learner, [tag()], { groupId: pub });

      // Read is open to a non-member in the org; the main feed does not carry it.
      const gf = await learner2.get('/api/learner/community').query({ group: pub }).expect(200);
      expect(gf.body.posts.map((p: { id: string }) => p.id)).toEqual([gp.id]);
      expect(gf.body.group).toEqual(expect.objectContaining({ name, joined: false }));
      const main = await learner2.get('/api/learner/community').query({ limit: 50 }).expect(200);
      expect(main.body.posts.map((p: { id: string }) => p.id)).not.toContain(gp.id);
      await learnerB.get('/api/learner/community').query({ group: pub }).expect(404);
      await learnerB.post(`/api/learner/community/groups/${pub}/join`).expect(404);

      // An admin curates a discussion into the group without joining it.
      const d = await adminA.post('/api/admin/community/discussions').send({ title: uniq('D'), hashtags: [tag()], groupId: intId }).expect(201);
      const [row] = await dbQuery('SELECT group_id FROM community_posts WHERE public_id = $1', [d.body.post.id]);
      expect(row.group_id).toBe(intId);

      const admList = await adminA.get('/api/admin/community/groups').expect(200);
      expect(admList.body.groups.find((x: { id: number }) => x.id === intId)).toEqual(expect.objectContaining({ memberCount: 1, postCount: 2 }));
      await noModerator.get('/api/admin/community/groups').expect(200);

      const leave = await learner.delete(`/api/learner/community/groups/${pub}/join`).expect(200);
      expect(leave.body).toEqual({ joined: false });
      expect((await dbQuery('SELECT 1 FROM community_group_members WHERE user_id = $1 AND group_id = $2', [fx.A.learner.id, intId]))).toHaveLength(0);

      await noModerator.patch(`/api/admin/community/groups/${intId}`).send({ archived: true }).expect(403);
      await adminB.patch(`/api/admin/community/groups/${intId}`).send({ archived: true }).expect(404);
      await adminA.patch(`/api/admin/community/groups/${intId}`).send({ name: `${name} renamed`, archived: true }).expect(200);
      const after = await learner.get('/api/learner/community/groups').expect(200);
      expect(after.body.groups.map((x: { name: string }) => x.name)).not.toContain(`${name} renamed`);
      await learner.post(`/api/learner/community/groups/${pub}/join`).expect(404);
      const admAfter = await adminA.get('/api/admin/community/groups').expect(200);
      expect(admAfter.body.groups.find((x: { id: number }) => x.id === intId)).toEqual(expect.objectContaining({ archived: true, name: `${name} renamed` }));
    });
  });

  describe('resources', () => {
    it('shares a small PDF that the org can open and another org cannot; a link resource works; bad input is refused', async () => {
      const t = tag();
      const r = await learner.post('/api/learner/community/resources')
        .field('title', uniq('Deck'))
        .field('hashtags', `#${t}, other${t}`)
        .attach('file', TINY_PDF, { filename: 'deck.pdf', contentType: 'application/pdf' })
        .expect(201);
      expect(r.body.post.type).toBe('resource');
      expect(r.body.post.resource).toEqual(expect.objectContaining({ kind: 'file', name: 'deck.pdf', mime: 'application/pdf', size: TINY_PDF.length }));
      expect(r.body.post.hashtags.map((h: { tag: string }) => h.tag)).toEqual(expect.arrayContaining([t.toLowerCase(), `other${t}`.toLowerCase()]));
      expect(JSON.stringify(r.body)).not.toMatch(/file_path|uploads/);

      const f = await learner2.get(`/api/learner/community/${r.body.post.id}/file`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(f.headers['content-type']).toMatch(/application\/pdf/);
      expect(f.headers['content-disposition']).toMatch(/deck\.pdf/);
      expect((f.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      await learnerB.get(`/api/learner/community/${r.body.post.id}/file`).expect(404);

      const feed = await learner2.get('/api/learner/community').query({ type: 'resource' }).expect(200);
      expect(feed.body.posts.map((p: { id: string }) => p.id)).toContain(r.body.post.id);

      const link = await learner.post('/api/learner/community/resources').field('title', uniq('Link')).field('link', 'https://example.org/spec').field('hashtags', t).expect(201);
      expect(link.body.post.resource).toEqual({ kind: 'link', url: 'https://example.org/spec' });
      await learner.get(`/api/learner/community/${link.body.post.id}/file`).expect(404);

      await learner.post('/api/learner/community/resources').field('title', uniq('None')).field('hashtags', t).expect(400);
      await learner.post('/api/learner/community/resources').field('title', uniq('Ftp')).field('link', 'ftp://x').field('hashtags', t).expect(400);
      await learner.post('/api/learner/community/resources').field('title', uniq('NoTag')).field('link', 'https://example.org').expect(400);
      const bad = await learner.post('/api/learner/community/resources').field('title', uniq('Txt')).field('hashtags', t)
        .attach('file', Buffer.from('just text'), { filename: 'notes.pdf', contentType: 'application/pdf' });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.status).toBeLessThan(500);
      // A resource cannot be minted through the JSON create.
      await learner.post('/api/learner/community').send({ type: 'resource', title: 'x', hashtags: [t] }).expect(400);
    });
  });

  describe('kudos', () => {
    it('gives kudos to an active learner-portal colleague with no hashtag, and notifies them', async () => {
      const before = (await notificationsOf(fx.A.learner2.id, 'kudos_received')).length;
      const k = await learner.post('/api/learner/community/kudos').send({ recipientUserId: fx.A.learner2.id, message: 'Great help on the deck' }).expect(201);
      expect(k.body.post).toEqual(expect.objectContaining({ type: 'kudos', body: 'Great help on the deck', title: null, hashtags: [] }));
      expect(k.body.post.recipient.name).toBe('Learnertwo T.');
      const rows = await waitNotifications(fx.A.learner2.id, 'kudos_received', before + 1);
      expect(rows[0].body).toMatch(/Great help/);

      // A manager rides the learner portal, so is a valid recipient.
      await learner.post('/api/learner/community/kudos').send({ recipientUserId: fx.A.manager.id, message: 'Thanks boss' }).expect(201);

      const summary = await learner2.get('/api/learner/community/kudos/summary').expect(200);
      expect(summary.body.received).toBeGreaterThanOrEqual(1);
      expect(summary.body.recent[0]).toEqual(expect.objectContaining({ message: 'Great help on the deck', from: expect.objectContaining({ name: 'Learner T.' }) }));

      const board = await learner.get('/api/learner/community/kudos/leaderboard').expect(200);
      const entry = board.body.entries.find((e: { userId: number }) => e.userId === fx.A.learner2.id);
      expect(entry.received).toBeGreaterThanOrEqual(1);
      expect(entry.rank).toBeGreaterThanOrEqual(1);
      const boardB = await learnerB.get('/api/learner/community/kudos/leaderboard').expect(200);
      expect(boardB.body.entries.map((e: { userId: number }) => e.userId)).not.toContain(fx.A.learner2.id);

      const feed = await learner2.get('/api/learner/community').query({ type: 'kudos' }).expect(200);
      expect(feed.body.posts.map((p: { id: string }) => p.id)).toContain(k.body.post.id);
    });

    it('refuses kudos to yourself (400), a trainer, a deactivated colleague or another org (404)', async () => {
      await learner.post('/api/learner/community/kudos').send({ recipientUserId: fx.A.learner.id, message: 'me' }).expect(400);
      await learner.post('/api/learner/community/kudos').send({ recipientUserId: fx.A.trainer.id, message: 'x' }).expect(404);
      await learner.post('/api/learner/community/kudos').send({ recipientUserId: fx.B.learner.id, message: 'x' }).expect(404);
      const gone = await newPerson(adminA, fx.A);
      await adminA.patch(`/api/admin/users/${gone.id}`).send({ is_active: false }).expect((r) => ok(r));
      await learner.post('/api/learner/community/kudos').send({ recipientUserId: gone.id, message: 'x' }).expect(404);
      await learner.post('/api/learner/community/kudos').send({ recipientUserId: fx.A.learner2.id, message: '' }).expect(400);
    });

    it('people search finds active learner-portal colleagues with full name, never the caller or another org', async () => {
      const r = await learner.get('/api/learner/community/people').query({ q: 'Learnertwo' }).expect(200);
      expect(r.body.people).toEqual([expect.objectContaining({ id: fx.A.learner2.id, name: 'Learnertwo Tester', department: 'Engineering' })]);
      const all = await learner.get('/api/learner/community/people').expect(200);
      const ids = all.body.people.map((p: { id: number }) => p.id);
      expect(ids).not.toContain(fx.A.learner.id);
      expect(ids).not.toContain(fx.A.trainer.id);
      expect(ids).not.toContain(fx.A.admin.id);
      expect(ids).not.toContain(fx.B.learner.id);
    });
  });

  describe('the organization switch', () => {
    it('turning the community off refuses every learner read and write, while moderators can still read', async () => {
      const post = await question(learner);
      await adminA.patch('/api/admin/organization').send({ community_enabled: false }).expect(200);
      try {
        const r = await learner.get('/api/learner/community').expect(403);
        expect(r.body.message).toMatch(/turned off/i);
        await learner.post('/api/learner/community').send({ type: 'question', title: 'x', hashtags: [tag()] }).expect(403);
        await learner.get(`/api/learner/community/${post.id}`).expect(403);
        await learner.post('/api/learner/community/kudos').send({ recipientUserId: fx.A.learner2.id, message: 'x' }).expect(403);
        await learner.get('/api/learner/community/groups').expect(403);
        await adminA.get(`/api/admin/community/${post.id}`).expect(200);
        // Org B is unaffected.
        await learnerB.get('/api/learner/community').expect(200);
      } finally {
        await adminA.patch('/api/admin/organization').send({ community_enabled: true }).expect(200);
      }
      await learner.get('/api/learner/community').expect(200);
    });
  });
});
