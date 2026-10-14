import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { actorLabel } from '@/common/notifications';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
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
  type CreatePostDto,
  type CreateReplyDto,
} from './dto/community.dto';

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
    query: { type?: string; cursor?: string; limit?: number },
  ) {
    await this.assertEnabled(scope);
    const limit = clampLimit(query.limit);
    const type = this.safeType(query.type);
    const cur = query.cursor ? decodeCursor(query.cursor) : {};
    const rows = await this.repository.feedFor(scope, user.userId, {
      type,
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
  ) {
    await this.assertEnabled(scope);
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

    const { id } = await this.repository.createPost({
      scope,
      userId: user.userId,
      type: dto.type,
      title,
      body,
      certificateId,
    });
    const post = await this.repository.getPost(scope, id, user.userId);
    return { post: this.shapePost(post as PostRow, user.userId) };
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
