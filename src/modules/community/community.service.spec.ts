import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { normalizeReactionCounts } from '@/common/community-reactions';

import { CommunityService } from './community.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as any;
const learner = { userId: 10, firstName: 'Asha', lastName: 'Rao', role: 'learner' } as any;
const admin = { userId: 99, firstName: 'Lee', lastName: 'Admin', role: 'admin' } as any;
const POST = { id: 5, publicId: 'p-uuid', userId: 10, type: 'question' };

function makeRepo(overrides: Partial<Record<string, any>> = {}) {
  return {
    communityEnabled: jest.fn().mockResolvedValue(true),
    findPost: jest.fn().mockResolvedValue(POST),
    findReply: jest.fn().mockResolvedValue(null),
    createReply: jest.fn().mockResolvedValue({ id: 300 }),
    setPostReaction: jest.fn().mockResolvedValue({ total: 2, counts: { helpful: 1, agree: 1 } }),
    removePostReaction: jest.fn().mockResolvedValue({ total: 1, counts: { agree: 1 } }),
    postReactors: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as any;
}

function makeService(repo = makeRepo()) {
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) } as any;
  const svc = new CommunityService(repo, notifications, {} as any);
  return { svc, repo, notifications };
}

describe('normalizeReactionCounts', () => {
  it('fills every kind, keeps positive integers and drops unknown kinds', () => {
    expect(normalizeReactionCounts({ helpful: 2, love: 9, agree: -1 })).toEqual({
      like: 0,
      helpful: 2,
      insightful: 0,
      thanks: 0,
      great_explanation: 0,
      agree: 0,
    });
    expect(normalizeReactionCounts(null).like).toBe(0);
  });
});

describe('CommunityService reactions', () => {
  it('sets a reaction and returns the full state', async () => {
    const { svc, repo } = makeService();
    const r = await svc.react(scope, learner, 5, 'helpful');
    expect(repo.setPostReaction).toHaveBeenCalledWith(scope, 5, 10, 'helpful');
    expect(r).toMatchObject({ myReaction: 'helpful', liked: true, likeCount: 2 });
    expect(r.reactions).toMatchObject({ helpful: 1, agree: 1, like: 0 });
  });

  it('removing returns no reaction of mine', async () => {
    const { svc } = makeService();
    const r = await svc.unreact(scope, learner, 5);
    expect(r).toMatchObject({ myReaction: null, liked: false, likeCount: 1 });
  });

  it('the old like route is the like reaction', async () => {
    const { svc, repo } = makeService();
    expect(await svc.like(scope, learner, 5)).toEqual({ liked: true, likeCount: 2 });
    expect(repo.setPostReaction).toHaveBeenCalledWith(scope, 5, 10, 'like');
  });

  it('a missing post is 404 and a switched-off community is 403', async () => {
    await expect(
      makeService(makeRepo({ findPost: jest.fn().mockResolvedValue(null) })).svc.react(scope, learner, 5, 'like'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      makeService(makeRepo({ communityEnabled: jest.fn().mockResolvedValue(false) })).svc.react(scope, admin, 5, 'like'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the admin view carries full participant details and counts', async () => {
    const repo = makeRepo({
      postReactors: jest.fn().mockResolvedValue([
        { author_id: 1, first_name: 'Asha', last_initial: 'R', author_name: 'Asha Rao', author_email: 'a@x.test', avatar_url: null, author_portal: 'learner', department: 'Ops', kind: 'agree', created_at: 't1' },
        { author_id: 2, first_name: 'Ben', last_initial: 'K', author_name: 'Ben Kumar', author_email: 'b@x.test', avatar_url: null, author_portal: 'admin', department: null, kind: 'agree', created_at: 't2' },
      ]),
    });
    const r = await makeService(repo).svc.adminPostReactors(scope, 5);
    expect(r.total).toBe(2);
    expect(r.counts.agree).toBe(2);
    expect(r.reactors[0]).toEqual({
      userId: 1, name: 'Asha Rao', email: 'a@x.test', department: 'Ops', avatar: null, portal: 'learner', kind: 'agree', reactedAt: 't1',
    });
  });
});

describe('CommunityService.reply threading', () => {
  it('a top-level reply has no parent and tells the post author only', async () => {
    const { svc, repo, notifications } = makeService();
    const r = await svc.reply(scope, { ...learner, userId: 11 }, 5, { body: 'Answer' });
    expect(repo.createReply).toHaveBeenCalledWith(expect.objectContaining({ parentReplyId: null }));
    expect(r.reply.parentReplyId).toBeNull();
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify.mock.calls[0][0].userIds).toEqual([10]);
  });

  it('the asker responding to an answer files under it and tells only the answerer', async () => {
    const repo = makeRepo({
      findReply: jest.fn().mockResolvedValue({ id: 200, userId: 11, postId: 5, parentReplyId: null }),
    });
    const { svc, notifications } = makeService(repo);
    const r = await svc.reply(scope, learner, 5, { body: 'Thanks', parentReplyId: 200 });
    expect(r.reply).toMatchObject({ parentReplyId: 200, isPostAuthor: true });
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({ userIds: [11], title: 'Someone responded to your answer' });
  });

  it('a response to a response stays one level deep', async () => {
    const repo = makeRepo({
      findReply: jest.fn().mockResolvedValue({ id: 201, userId: 11, postId: 5, parentReplyId: 200 }),
    });
    const { svc } = makeService(repo);
    await svc.reply(scope, admin, 5, { body: 'Agreed', parentReplyId: 201 });
    expect(repo.createReply).toHaveBeenCalledWith(expect.objectContaining({ parentReplyId: 200 }));
  });

  it('a parent on another post is not found', async () => {
    const repo = makeRepo({
      findReply: jest.fn().mockResolvedValue({ id: 201, userId: 11, postId: 6, parentReplyId: null }),
    });
    await expect(
      makeService(repo).svc.reply(scope, learner, 5, { body: 'x', parentReplyId: 201 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.createReply).not.toHaveBeenCalled();
  });

  it('an admin reply is marked as staff', async () => {
    const { svc } = makeService();
    const r = await svc.reply(scope, admin, 5, { body: 'From L&D' });
    expect(r.reply.author.isStaff).toBe(true);
  });
});
