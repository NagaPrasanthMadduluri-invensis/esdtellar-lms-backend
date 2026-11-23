import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { actorLabel } from '@/common/notifications';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { collectHashtags, extractInlineHashtags } from '@/common/community-hashtags';
import { leaderboardName, toNameDisplay } from '@/common/leaderboard-privacy';
import {
  type CommunityReaction,
  normalizeReactionCounts,
} from '@/common/community-reactions';
import { type OrgScope } from '@/database/org-scope';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { SharedFileService } from '@/modules/files/shared-file.service';

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
  type CreateResourceDto,
} from './dto/community.dto';

// Types a learner can FILTER the feed by — the three compose types plus kudos
// and resource (each created through its own endpoint, never the JSON create).
const FEED_FILTER_TYPES = [...COMMUNITY_POST_TYPES, 'kudos', 'resource'] as const;

@Injectable()
export class CommunityService {
  constructor(
    private readonly repository: CommunityRepository,
    private readonly notifications: NotificationsService,
    private readonly files: SharedFileService,
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
      replies: replies.map((r) => this.shapeReply(r, user.userId, post.author_id)),
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

  // ── Resources ────────────────────────────────────────────────────────────

  /**
   * Share a resource with the whole community — a link OR a PDF/image file.
   * Multipart; main-feed only in v1. Exactly one of file/link, a title, and at
   * least one hashtag like every post.
   */
  async createResource(
    scope: OrgScope,
    user: AuthenticatedUser,
    dto: CreateResourceDto,
    file: Express.Multer.File | undefined,
  ) {
    await this.assertEnabled(scope);

    const link = dto.link?.trim();
    if (file && link) {
      throw new BadRequestException('Share a file or a link, not both');
    }
    if (!file && !link) {
      throw new BadRequestException('Attach a file or add a link to share');
    }
    if (link && !/^https?:\/\/.+/i.test(link)) {
      throw new BadRequestException('A link must start with http:// or https://');
    }

    const tags = collectHashtags([
      ...(dto.hashtags ? dto.hashtags.split(/[,\s]+/) : []),
      ...extractInlineHashtags(dto.title),
      ...extractInlineHashtags(dto.body),
    ]);
    if (tags.length === 0) {
      throw new BadRequestException('Add at least one hashtag');
    }

    // A file is validated and written BEFORE the row; if the insert then fails
    // the bytes are discarded, the external-cert rollback (§10.26).
    const stored = file ? await this.files.store(file) : null;

    let id: number;
    try {
      ({ id } = await this.repository.createPost({
        scope,
        userId: user.userId,
        type: 'resource',
        title: dto.title,
        body: dto.body ?? null,
        certificateId: null,
        resource: stored
          ? {
              filePath: stored.path,
              fileName: stored.name,
              fileMime: stored.mime,
              fileSize: stored.size,
            }
          : { url: link },
      }));
    } catch (error) {
      await this.files.discard(stored?.path);
      throw error;
    }

    const hashtagIds = await this.repository.upsertHashtags(scope, tags);
    await this.repository.linkPostHashtags(id, hashtagIds);
    const post = await this.repository.getPost(scope, id, user.userId);
    return { post: this.shapePost(post as PostRow, user.userId) };
  }

  /** Stream a resource post's file — any member of the post's org may read it
   *  (a resource is shared with the whole community). */
  async postFile(scope: OrgScope, postId: number) {
    await this.assertEnabled(scope);
    const row = await this.repository.findPostFile(scope, postId);
    if (!row || !row.file_path) throw new NotFoundException('File not found');
    return {
      stream: this.files.open(row.file_path),
      fileName: row.file_name ?? 'file',
      mime: row.file_mime ?? 'application/octet-stream',
    };
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
    const [rows, settings] = await Promise.all([
      this.repository.kudosLeaderboard(scope, 50),
      this.repository.leaderboardSettings(scope),
    ]);
    // The kudos board sits on the leaderboard page, so the organization's
    // leaderboard switch turns it off too (0064).
    if (Number(settings.leaderboard_enabled) !== 1) {
      throw new ForbiddenException('The leaderboard is turned off for your organization');
    }
    const display = toNameDisplay(settings.leaderboard_name_display);
    return {
      entries: rows.map((r, i) => ({
        rank: i + 1,
        userId: r.user_id,
        name: leaderboardName(r.first_name, r.last_name, display),
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

  /**
   * Reply to a post, or respond to a reply on it (`parentReplyId`). Shared by
   * the learner and admin controllers: an Admin takes part exactly like a
   * Learner. A response is kept one level deep: answering a response files it
   * under the same top-level reply, so a thread never becomes a staircase.
   */
  async reply(
    scope: OrgScope,
    user: AuthenticatedUser,
    postId: number,
    dto: CreateReplyDto,
  ) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');

    let parent: Awaited<ReturnType<CommunityRepository['findReply']>> = null;
    if (dto.parentReplyId !== undefined) {
      parent = await this.repository.findReply(scope, dto.parentReplyId);
      // Another post's reply (or another org's) is "not found" on this post.
      if (!parent || parent.postId !== postId) {
        throw new NotFoundException('Reply not found');
      }
    }
    const parentReplyId = parent ? (parent.parentReplyId ?? parent.id) : null;

    const { id } = await this.repository.createReply({
      scope,
      postId,
      userId: user.userId,
      body: dto.body,
      parentReplyId,
    });

    // Tell the post's author and, for a response, the reply's author. Never
    // the person replying, never anyone twice. Best-effort (§8.4).
    const link = `/community/${post.publicId}`;
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
        link,
        subjectType: 'community_post',
        subjectId: post.id,
        actorName: actorLabel(user),
        exceptUserId: user.userId,
      });
    }
    if (parent && parent.userId !== user.userId && parent.userId !== post.userId) {
      void this.notifications.notify({
        userIds: [parent.userId],
        organizationId: scope.organizationId,
        type: 'community_reply',
        title:
          post.type === 'question'
            ? 'Someone responded to your answer'
            : 'Someone responded to your comment',
        body: `${actorLabel(user)} responded.`,
        link,
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
        parentReplyId,
        body: dto.body,
        likeCount: 0,
        createdAt: new Date().toISOString(),
        editedAt: null,
        likedByMe: false,
        isMine: true,
        isPostAuthor: post.userId === user.userId,
        author: {
          name: lastInitial
            ? `${user.firstName} ${lastInitial}.`
            : user.firstName,
          avatar: null,
          isStaff: user.role === 'admin',
        },
      },
    };
  }

  /**
   * Set the caller's quick reaction on a post (0073). One per person per post:
   * a different kind replaces the old one. Shared by both portals.
   */
  async react(
    scope: OrgScope,
    user: AuthenticatedUser,
    postId: number,
    kind: CommunityReaction,
  ) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    const { total, counts } = await this.repository.setPostReaction(
      scope,
      postId,
      user.userId,
      kind,
    );
    return this.reactionState(kind, total, counts);
  }

  async unreact(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    const { total, counts } = await this.repository.removePostReaction(
      postId,
      user.userId,
    );
    return this.reactionState(null, total, counts);
  }

  /** The original heart: a Like is the `like` reaction. Kept for old clients. */
  async like(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    const state = await this.react(scope, user, postId, 'like');
    return { liked: true, likeCount: state.likeCount };
  }

  async unlike(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    const state = await this.unreact(scope, user, postId);
    return { liked: false, likeCount: state.likeCount };
  }

  /**
   * Who reacted to a post, learner view: first name + last initial and the
   * reaction, newest first. `likers` is the old name, kept for old clients.
   */
  async postLikers(scope: OrgScope, user: AuthenticatedUser, postId: number) {
    await this.assertEnabled(scope);
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    const rows = await this.repository.postReactors(scope, postId, 200);
    const likers = rows.map((r) => ({
      user_id: r.author_id,
      name: r.last_initial ? `${r.first_name} ${r.last_initial}.` : r.first_name,
      avatar: r.avatar_url,
      is_me: r.author_id === user.userId,
      is_staff: r.author_portal === 'admin',
      kind: r.kind,
    }));
    return { likers, counts: countKinds(rows) };
  }

  /**
   * Who reacted to a post, admin view: the full participant record (full name,
   * email, department, role, reaction, when) and the per-kind counts. No
   * enabled gate: an Admin can inspect a switched-off community.
   */
  async adminPostReactors(scope: OrgScope, postId: number) {
    const post = await this.repository.findPost(scope, postId);
    if (!post) throw new NotFoundException('Post not found');
    const rows = await this.repository.postReactors(scope, postId, 500);
    return {
      total: rows.length,
      counts: countKinds(rows),
      reactors: rows.map((r) => ({
        userId: r.author_id,
        name: r.author_name || r.first_name,
        email: r.author_email,
        department: r.department,
        avatar: r.avatar_url,
        portal: r.author_portal,
        kind: r.kind,
        reactedAt: r.created_at,
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
    admin: AuthenticatedUser,
    query: { type?: string; search?: string; page?: number; limit?: number },
  ) {
    const limit = clampLimit(query.limit);
    const page = Math.max(query.page ?? 1, 1);
    const offset = (page - 1) * limit;
    const type = this.safeType(query.type);
    const search = query.search?.trim() || undefined;
    const [rows, total] = await Promise.all([
      this.repository.adminFeed(scope, admin.userId, { type, search, limit, offset }),
      this.repository.countForAdmin(scope, { type, search }),
    ]);
    return {
      posts: rows.map((r) => this.shapePost(r, admin.userId, true)),
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
      post: this.shapePost(post, admin.userId, true),
      replies: replies.map((r) =>
        this.shapeReply(r, admin.userId, post.author_id, true),
      ),
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

  private reactionState(
    myReaction: CommunityReaction | null,
    total: number,
    counts: Record<string, number>,
  ) {
    return {
      myReaction,
      // `liked` / `likeCount` keep their old meaning for old clients: "I have
      // reacted" and the post's total across every kind.
      liked: myReaction !== null,
      likeCount: total,
      reactions: normalizeReactionCounts(counts),
    };
  }

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
      myReaction: row.my_reaction ?? null,
      reactions: normalizeReactionCounts(row.reaction_counts),
      isMine: row.author_id === meId,
      author: {
        name,
        avatar: row.avatar_url,
        email: admin ? row.author_email : undefined,
        isStaff: row.author_portal === 'admin',
      },
      certificate: row.cert_public_id
        ? {
            publicId: row.cert_public_id,
            code: row.cert_code,
            revoked: row.cert_revoked === 1,
          }
        : null,
      hashtags: row.hashtags ?? [],
      // Present only on a resource post: a link, or a file (streamed via the
      // post's own route — the client builds the URL from the post id).
      resource:
        row.type === 'resource'
          ? row.resource_url
            ? { kind: 'link', url: row.resource_url }
            : {
                kind: 'file',
                name: row.file_name,
                mime: row.file_mime,
                size: row.file_size,
              }
          : null,
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

  private shapeReply(
    row: ReplyRow,
    meId: number,
    postAuthorId: number,
    admin = false,
  ) {
    const name = admin
      ? row.author_name
      : row.last_initial
        ? `${row.first_name} ${row.last_initial}.`
        : row.first_name;
    return {
      id: row.id,
      parentReplyId: row.parent_reply_id ?? null,
      body: row.body,
      likeCount: row.like_count,
      createdAt: row.created_at,
      editedAt: row.edited_at,
      likedByMe: row.liked_by_me,
      isMine: row.author_id === meId,
      // The post's own author answering on it: the asker, on a question.
      isPostAuthor: row.author_id === postAuthorId,
      author: {
        name,
        avatar: row.avatar_url,
        isStaff: row.author_portal === 'admin',
      },
    };
  }
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
function clampLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function countKinds(rows: { kind: string }[]): Record<CommunityReaction, number> {
  const raw: Record<string, number> = {};
  for (const r of rows) raw[r.kind] = (raw[r.kind] ?? 0) + 1;
  return normalizeReactionCounts(raw);
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
