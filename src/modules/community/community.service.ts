import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { actorLabel } from '@/common/notifications';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { collectHashtags, extractInlineHashtags } from '@/common/community-hashtags';
import { type OrgScope } from '@/database/org-scope';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import {
  CommunityRepository,
  type PostRow,
  type ReplyRow,
} from './community.repository';
import {
  COMMUNITY_POST_TYPES,
  type CommunityPostType,
  type CreateKudosDto,
  type CreatePostDto,
  type CreateReplyDto,
} from './dto/community.dto';

// Types a learner can FILTER the feed by — the three compose types plus kudos
// (which is created through its own endpoint, never the compose picker).
const FEED_FILTER_TYPES = [...COMMUNITY_POST_TYPES, 'kudos'] as const;

@Injectable()
export class CommunityService {
  constructor(
    private readonly repository: CommunityRepository,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Learner ──────────────────────────────────────────────────────────────

  async feed(
    scope: OrgScope,
    user: AuthenticatedUser,
    query: {
      type?: string;
      hashtag?: string;
      groupId?: number;
      cursor?: string;
      limit?: number;
    },
  ) {
    await this.assertEnabled(scope);
    const limit = clampLimit(query.limit);
    const type = this.safeFilterType(query.type);
    // Normalise the hashtag filter the same way it was stored, so #Renewables
    // and renewables both match.
    const [tag] = collectHashtags([query.hashtag ?? '']);
    const hashtag = tag?.tag;

    // A group feed is readable by the org; posting into it needs membership
    // (checked in createPost). The main feed is group_id IS NULL.
    let group = null;
    if (query.groupId !== undefined) {
      const g = await this.repository.findGroup(scope, query.groupId);
      if (!g || g.archived_at) throw new NotFoundException('Group not found');
      group = {
        id: g.public_id,
        name: g.name,
        description: g.description,
        joined: await this.repository.isGroupMember(query.groupId, user.userId),
      };
    }

    const cur = query.cursor ? decodeCursor(query.cursor) : {};
    const rows = await this.repository.feedFor(scope, user.userId, {
      type,
      hashtag,
      groupId: query.groupId,
      cursorTs: cur.cursorTs,
      cursorId: cur.cursorId,
      limit: limit + 1,
    });
    let nextCursor: string | null = null;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      nextCursor = encodeCursor(last.created_at, last.post_pk ?? 0);
      rows.length = limit;
    }
    return {
      posts: rows.map((r) => this.shapePost(r, user.userId)),
      nextCursor,
      group,
    };
  }

  async detail(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    await this.assertEnabled(scope);
    const post = await this.repository.getPost(scope, postId, user.userId);
    if (!post) throw new NotFoundException('Post not found');
    const replies = await this.repository.listReplies(scope, postId, user.userId, {
      limit: 100,
      offset: 0,
    });
    return {
      post: this.shapePost(post, user.userId),
      replies: replies.map((r) => this.shapeReply(r, user.userId)),
    };
  }

  async createPost(
    scope: OrgScope,
    user: AuthenticatedUser,
    dto: CreatePostDto,
    resolvedGroupId?: number,
  ) {
    await this.assertEnabled(scope);

    // Discussions are admin-curated (§10.41): a learner creates questions,
    // achievements and kudos, and replies to everything, but does not start a
    // discussion thread. Admins create those via the admin controller.
    if (dto.type === 'discussion') {
      throw new ForbiddenException(
        'Discussions are started by your admins. You can reply to them, or ask a question instead.',
      );
    }

    // Posting into a group requires membership; the main feed (no group) does
    // not. The group must exist in this org. `resolvedGroupId` is the integer
    // the controller resolved from the post's public group id.
    let groupId: number | null = null;
    if (resolvedGroupId !== undefined) {
      const g = await this.repository.findGroup(scope, resolvedGroupId);
      if (!g || g.archived_at) throw new NotFoundException('Group not found');
      if (!(await this.repository.isGroupMember(resolvedGroupId, user.userId))) {
        throw new ForbiddenException('Join the group to post in it');
      }
      groupId = resolvedGroupId;
    }

    let title: string | null = dto.title ?? null;
    const body: string | null = dto.body ?? null;
    let certificateId: number | null = null;

    if (dto.type === 'achievement') {
      if (!dto.certificateId) {
        throw new BadRequestException('Choose a certificate to share');
      }
      const cert = await this.repository.certDisplay(
        scope,
        dto.certificateId,
        user.userId,
      );
      if (!cert) {
        throw new NotFoundException('Certificate not found');
      }
      // The achievement's name is captured at share time so the feed never has
      // to join the certificate tables.
      title = cert.journey_name || cert.course_name || 'Achievement';
      certificateId = dto.certificateId;
    } else if (!title) {
      throw new BadRequestException('A title is required');
    }

    // Hashtags: the chip input plus any #tokens typed inline in the title/body,
    // normalised and de-duplicated. Every post requires at least one.
    const tags = collectHashtags([
      ...(dto.hashtags ?? []),
      ...extractInlineHashtags(title),
      ...extractInlineHashtags(body),
    ]);
    if (tags.length === 0) {
      throw new BadRequestException('Add at least one hashtag');
    }

    const { id } = await this.repository.createPost({
      scope,
      userId: user.userId,
      type: dto.type,
      title,
      body,
      certificateId,
      groupId,
    });
    const hashtagIds = await this.repository.upsertHashtags(scope, tags);
    await this.repository.linkPostHashtags(id, hashtagIds);
    const post = await this.repository.getPost(scope, id, user.userId);
    return { post: this.shapePost(post as PostRow, user.userId) };
  }

  // ── Groups ──────────────────────────────────────────────────────────────────

  /** Groups a learner can see (active), with counts and their join state. */
  async listGroups(scope: OrgScope, user: AuthenticatedUser) {
    await this.assertEnabled(scope);
    const rows = await this.repository.listGroupsForLearner(scope, user.userId);
    return {
      groups: rows.map((g) => ({
        id: g.public_id,
        name: g.name,
        description: g.description,
        memberCount: g.member_count,
        postCount: g.post_count,
        joined: g.joined,
      })),
    };
  }

  async joinGroup(scope: OrgScope, user: AuthenticatedUser, groupId: number) {
    await this.assertEnabled(scope);
    const g = await this.repository.findGroup(scope, groupId);
    if (!g || g.archived_at) throw new NotFoundException('Group not found');
    await this.repository.joinGroup(scope, groupId, user.userId);
    return { joined: true };
  }

  async leaveGroup(scope: OrgScope, user: AuthenticatedUser, groupId: number) {
    await this.assertEnabled(scope);
    const g = await this.repository.findGroup(scope, groupId);
    if (!g) throw new NotFoundException('Group not found');
    await this.repository.leaveGroup(groupId, user.userId);
    return { joined: false };
  }

  // ── Admin: groups + discussions ─────────────────────────────────────────────

  async adminListGroups(scope: OrgScope) {
    const rows = await this.repository.listGroupsForAdmin(scope);
    return {
      // Integer ids: the admin screens carry no id in a browser URL (§10.34).
      groups: rows.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        archived: g.archived,
        memberCount: g.member_count,
        postCount: g.post_count,
      })),
    };
  }

  async adminCreateGroup(
    scope: OrgScope,
    admin: AuthenticatedUser,
    dto: { name: string; description?: string },
  ) {
    const { id } = await this.repository.createGroup({
      scope,
      name: dto.name,
      description: dto.description ?? null,
      createdBy: admin.userId,
    });
    const g = await this.repository.findGroup(scope, id);
    return {
      group: {
        id: g!.id,
        name: g!.name,
        description: g!.description,
        archived: false,
        memberCount: 0,
        postCount: 0,
      },
    };
  }

  async adminUpdateGroup(
    scope: OrgScope,
    groupId: number,
    dto: { name?: string; description?: string; archived?: boolean },
  ) {
    const g = await this.repository.findGroup(scope, groupId);
    if (!g) throw new NotFoundException('Group not found');
    await this.repository.updateGroup(scope, groupId, dto);
    return { ok: true };
  }

  /** Admin-only discussion creation (the Discussion type is admin-curated). */
  async adminCreateDiscussion(
    scope: OrgScope,
    admin: AuthenticatedUser,
    dto: {
      title: string;
      body?: string;
      hashtags?: string[];
      groupId?: number;
    },
  ) {
    await this.assertEnabled(scope);

    let groupId: number | null = null;
    if (dto.groupId !== undefined) {
      const g = await this.repository.findGroup(scope, dto.groupId);
      if (!g || g.archived_at) throw new NotFoundException('Group not found');
      groupId = dto.groupId; // an admin curates a group without joining it
    }

    const tags = collectHashtags([
      ...(dto.hashtags ?? []),
      ...extractInlineHashtags(dto.title),
      ...extractInlineHashtags(dto.body),
    ]);
    if (tags.length === 0) {
      throw new BadRequestException('Add at least one hashtag');
    }

    const { id } = await this.repository.createPost({
      scope,
      userId: admin.userId,
      type: 'discussion',
      title: dto.title,
      body: dto.body ?? null,
      certificateId: null,
      groupId,
    });
    const hashtagIds = await this.repository.upsertHashtags(scope, tags);
    await this.repository.linkPostHashtags(id, hashtagIds);
    const post = await this.repository.getPost(scope, id, admin.userId);
    return { post: this.shapePost(post as PostRow, admin.userId) };
  }

  // ── Kudos ──────────────────────────────────────────────────────────────────

  async giveKudos(
    scope: OrgScope,
    user: AuthenticatedUser,
    dto: CreateKudosDto,
  ) {
    await this.assertEnabled(scope);
    if (dto.recipientUserId === user.userId) {
      throw new BadRequestException('You cannot give kudos to yourself');
    }
    const ok = await this.repository.isKudosRecipient(scope, dto.recipientUserId);
    if (!ok) {
      // A cross-tenant or non-learner id resolves to nothing — 404, not 403, so
      // the id cannot be used to probe who exists in another org.
      throw new NotFoundException('That person could not be found');
    }

    // A kudos is a community_posts row of type 'kudos' (one engine): the giver
    // is the author, the recipient is recipient_user_id, the message is body.
    // Kudos carries no hashtag and no title.
    const { id } = await this.repository.createPost({
      scope,
      userId: user.userId,
      type: 'kudos',
      title: null,
      body: dto.message,
      certificateId: null,
      recipientUserId: dto.recipientUserId,
    });

    // Tell the recipient. Best-effort (§8.4).
    const post = await this.repository.getPost(scope, id, user.userId);
    void this.notifications.notify({
      userIds: [dto.recipientUserId],
      organizationId: scope.organizationId,
      type: 'kudos_received',
      title: 'You received kudos',
      body: `${actorLabel(user)} recognised you: "${truncate(dto.message, 120)}"`,
      link: post ? `/community/${post.public_id}` : '/community',
      subjectType: 'community_post',
      subjectId: id,
      actorName: actorLabel(user),
      exceptUserId: user.userId,
    });

    return { post: this.shapePost(post as PostRow, user.userId) };
  }

  async searchPeople(scope: OrgScope, user: AuthenticatedUser, q?: string) {
    await this.assertEnabled(scope);
    const rows = await this.repository.searchPeople(scope, q?.trim(), user.userId, 10);
    return {
      people: rows.map((r) => ({
        id: r.id,
        name: r.name,
        department: r.department,
        avatar: r.avatar_url,
      })),
    };
  }

  async kudosSummary(scope: OrgScope, user: AuthenticatedUser) {
    await this.assertEnabled(scope);
    const { received, recent } = await this.repository.kudosForUser(
      scope,
      user.userId,
      5,
    );
    return {
      received,
      recent: recent.map((r) => ({
        id: r.public_id,
        message: r.body,
        createdAt: r.created_at,
        from: {
          name: r.last_initial
            ? `${r.first_name} ${r.last_initial}.`
            : r.first_name,
          avatar: r.avatar_url,
        },
      })),
    };
  }

  async kudosLeaderboard(scope: OrgScope, user: AuthenticatedUser) {
    await this.assertEnabled(scope);
    const rows = await this.repository.kudosLeaderboard(scope, 50);
    return {
      entries: rows.map((r, i) => ({
        rank: i + 1,
        userId: r.user_id,
        name: r.last_initial
          ? `${r.first_name} ${r.last_initial}.`
          : r.first_name,
        department: r.department,
        avatarUrl: r.avatar_url,
        received: r.received,
        isYou: r.user_id === user.userId,
      })),
    };
  }

  async hashtagSuggest(scope: OrgScope, q?: string) {
    await this.assertEnabled(scope);
    const [tag] = collectHashtags([q ?? '']);
    if (!tag) return { hashtags: [] };
    const rows = await this.repository.suggestHashtags(scope, tag.tag, 10);
    return { hashtags: rows };
  }

  async hashtagTrending(scope: OrgScope) {
    await this.assertEnabled(scope);
    const rows = await this.repository.trendingHashtags(scope, 30, 12);
    return { hashtags: rows };
  }

  async reply(
    scope: OrgScope,
    user: AuthenticatedUser,
    postId: number,
    dto: CreateReplyDto,
  ) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');

    const { id } = await this.repository.createReply({
      scope,
      postId,
      userId: user.userId,
      body: dto.body,
    });

    // Tell the author, unless they replied to themselves. Best-effort (§8.4).
    if (post.userId !== user.userId) {
      void this.notifications.notify({
        userIds: [post.userId],
        organizationId: scope.organizationId,
        type: 'community_reply',
        title:
          post.type === 'question'
            ? 'New contribution to your question'
            : 'New reply to your post',
        body: `${actorLabel(user)} replied.`,
        link: `/community/${post.publicId}`,
        subjectType: 'community_post',
        subjectId: post.id,
        actorName: actorLabel(user),
        exceptUserId: user.userId,
      });
    }

    const lastInitial = (user.lastName?.trim()?.[0] || '').toUpperCase() || null;
    return {
      reply: {
        id,
        body: dto.body,
        likeCount: 0,
        createdAt: new Date().toISOString(),
        editedAt: null,
        likedByMe: false,
        isMine: true,
        author: {
          name: lastInitial
            ? `${user.firstName} ${lastInitial}.`
            : user.firstName,
          avatar: null,
        },
      },
    };
  }

  async like(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    const likeCount = await this.repository.likePost(scope, postId, user.userId);
    return { liked: true, likeCount };
  }

  async unlike(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    const likeCount = await this.repository.unlikePost(postId, user.userId);
    return { liked: false, likeCount };
  }

  /** The people who liked a post — first name + last initial, newest first. */
  async postLikers(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    const rows = await this.repository.postLikers(scope, postId, 200);
    return {
      likers: rows.map((r) => ({
        user_id: r.author_id,
        name: r.last_initial ? `${r.first_name} ${r.last_initial}.` : r.first_name,
        avatar: r.avatar_url,
        is_me: r.author_id === user.userId,
      })),
    };
  }

  async deleteOwnPost(
    scope: OrgScope,
    user: AuthenticatedUser,
    postId: number,
  ) {
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    if (post.userId !== user.userId) {
      throw new ForbiddenException('You can only delete your own post');
    }
    await this.repository.softDeletePost(scope, postId, user.userId);
    return { ok: true };
  }

  async deleteOwnReply(
    scope: OrgScope,
    user: AuthenticatedUser,
    replyId: number,
  ) {
    const reply = await this.repository.findReply(scope, replyId);
    if (!reply) throw new NotFoundException('Reply not found');
    if (reply.userId !== user.userId) {
      throw new ForbiddenException('You can only delete your own reply');
    }
    await this.repository.softDeleteReply(
      scope,
      replyId,
      reply.postId,
      user.userId,
    );
    return { ok: true };
  }

  // ── Admin (moderation) ────────────────────────────────────────────────────

  async adminFeed(
    scope: OrgScope,
    query: { type?: string; search?: string; page?: number; limit?: number },
  ) {
    const limit = clampLimit(query.limit);
    const page = Math.max(query.page ?? 1, 1);
    const offset = (page - 1) * limit;
    const type = this.safeType(query.type);
    const search = query.search?.trim() || undefined;
    const [rows, total] = await Promise.all([
      this.repository.adminFeed(scope, { type, search, limit, offset }),
      this.repository.countForAdmin(scope, { type, search }),
    ]);
    return {
      posts: rows.map((r) => this.shapePost(r, -1, true)),
      total,
      page,
      limit,
    };
  }

  async adminDetail(
    scope: OrgScope,
    admin: AuthenticatedUser,
    postId: number,
  ) {
    // No enabled gate — moderators can inspect even a switched-off community.
    const post = await this.repository.getPost(scope, postId, admin.userId);
    if (!post) throw new NotFoundException('Post not found');
    const replies = await this.repository.listReplies(
      scope,
      postId,
      admin.userId,
      { limit: 200, offset: 0 },
    );
    return {
      post: this.shapePost(post, -1, true),
      replies: replies.map((r) => this.shapeReply(r, -1)),
    };
  }

  async adminDeletePost(
    scope: OrgScope,
    admin: AuthenticatedUser,
    postId: number,
  ) {
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    await this.repository.softDeletePost(scope, postId, admin.userId);
    if (post.userId !== admin.userId) {
      void this.notifications.notify({
        userIds: [post.userId],
        organizationId: scope.organizationId,
        type: 'community_post_removed',
        title: 'A post was removed',
        body: 'A moderator removed one of your community posts.',
        link: '/community',
        subjectType: 'community_post',
        subjectId: post.id,
        exceptUserId: admin.userId,
      });
    }
    return { ok: true };
  }

  async adminDeleteReply(
    scope: OrgScope,
    admin: AuthenticatedUser,
    replyId: number,
  ) {
    const reply = await this.repository.findReply(scope, replyId);
    if (!reply) throw new NotFoundException('Reply not found');
    await this.repository.softDeleteReply(
      scope,
      replyId,
      reply.postId,
      admin.userId,
    );
    return { ok: true };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async assertEnabled(scope: OrgScope) {
    const on = await this.repository.communityEnabled(scope);
    if (!on) {
      throw new ForbiddenException(
        'The learning community is turned off for your organization',
      );
    }
  }

  private safeType(type?: string): CommunityPostType | undefined {
    return type && (COMMUNITY_POST_TYPES as readonly string[]).includes(type)
      ? (type as CommunityPostType)
      : undefined;
  }

  // Like safeType, but also lets the feed be filtered to kudos.
  private safeFilterType(type?: string): string | undefined {
    return type && (FEED_FILTER_TYPES as readonly string[]).includes(type)
      ? type
      : undefined;
  }

  private shapePost(row: PostRow, meId: number, admin = false) {
    const name = admin
      ? row.author_name
      : row.last_initial
        ? `${row.first_name} ${row.last_initial}.`
        : row.first_name;
    return {
      id: row.public_id,
      type: row.type,
      title: row.title,
      body: row.body,
      replyCount: row.reply_count,
      likeCount: row.like_count,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      likedByMe: row.liked_by_me,
      isMine: row.author_id === meId,
      author: {
        name,
        avatar: row.avatar_url,
        email: admin ? row.author_email : undefined,
      },
      certificate: row.cert_public_id
        ? {
            publicId: row.cert_public_id,
            code: row.cert_code,
            revoked: row.cert_revoked === 1,
          }
        : null,
      hashtags: row.hashtags ?? [],
      // Present only on a kudos post; the person recognised (first + initial).
      recipient:
        row.type === 'kudos' && row.recipient_first_name
          ? {
              name: row.recipient_last_initial
                ? `${row.recipient_first_name} ${row.recipient_last_initial}.`
                : row.recipient_first_name,
              avatar: row.recipient_avatar,
            }
          : null,
    };
  }

  private shapeReply(row: ReplyRow, meId: number) {
    const name = row.last_initial
      ? `${row.first_name} ${row.last_initial}.`
      : row.first_name;
    return {
      id: row.id,
      body: row.body,
      likeCount: row.like_count,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      likedByMe: row.liked_by_me,
      isMine: row.author_id === meId,
      author: { name, avatar: row.avatar_url },
    };
  }
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function encodeCursor(ts: string, id: number): string {
  return Buffer.from(`${ts}|${id}`).toString('base64url');
}
function decodeCursor(c: string): { cursorTs?: string; cursorId?: number } {
  try {
    const [ts, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
    const n = Number(id);
    if (!ts || Number.isNaN(n)) return {};
    return { cursorTs: ts, cursorId: n };
  } catch {
    return {};
  }
}
