import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import {
  communityPosts,
  communityReactions,
  communityReplies,
} from '@/database/schema';

export interface PostRow {
  post_pk?: number;
  public_id: string;
  type: string;
  title: string | null;
  body: string | null;
  reply_count: number;
  like_count: number;
  created_at: string;
  edited_at: string | null;
  author_id: number;
  first_name: string;
  last_initial: string | null;
  author_name: string;
  author_email: string | null;
  avatar_url: string | null;
  cert_public_id: string | null;
  cert_code: string | null;
  cert_revoked: number | null;
  liked_by_me: boolean;
}

export interface ReplyRow {
  id: number;
  body: string;
  like_count: number;
  created_at: string;
  edited_at: string | null;
  author_id: number;
  first_name: string;
  last_initial: string | null;
  author_name: string;
  avatar_url: string | null;
  liked_by_me: boolean;
}

interface CertDisplayRow {
  certificate_code: string;
  journey_id: number | null;
  course_name: string | null;
  session_id: number | null;
  journey_name: string | null;
}

@Injectable()
export class CommunityRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // Author identity, reused by feed, detail and replies. First name + last
  // initial for the learner-facing surfaces (the §10.24 relaxation); the full
  // name is also returned for the admin moderation read.
  private authorColumns(alias: string) {
    const a = sql.identifier(alias);
    return sql`
      ${a}.id AS author_id,
      ${a}.first_name,
      NULLIF(UPPER(LEFT(TRIM(${a}.last_name), 1)), '') AS last_initial,
      TRIM(COALESCE(${a}.first_name, '') || ' ' || COALESCE(${a}.last_name, '')) AS author_name,
      ${a}.email AS author_email,
      ${a}.avatar_url`;
  }

  /** The feed — one org, newest first, keyset-paginated, deleted hidden. */
  async feedFor(
    scope: OrgScope,
    userId: number,
    opts: { type?: string; cursorTs?: string; cursorId?: number; limit: number },
  ): Promise<PostRow[]> {
    const typeFilter = opts.type ? sql` AND p.type = ${opts.type}` : sql``;
    const cursor =
      opts.cursorTs && opts.cursorId !== undefined
        ? sql` AND (p.created_at, p.id) < (${opts.cursorTs}, ${opts.cursorId})`
        : sql``;
    return this.db.all<PostRow>(sql`
      SELECT p.id AS post_pk, p.public_id, p.type, p.title, p.body,
             p.reply_count, p.like_count, p.created_at, p.edited_at,
             ${this.authorColumns('u')},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             EXISTS (SELECT 1 FROM community_reactions r
                      WHERE r.post_id = p.id AND r.user_id = ${userId}) AS liked_by_me
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
   LEFT JOIN certificates cert ON cert.id = p.certificate_id
       WHERE ${orgScope('p', scope)}
         AND p.deleted_at IS NULL
         ${typeFilter}${cursor}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${opts.limit}
    `);
  }

  /** Is the Learning Community switched on for this tenant? */
  async communityEnabled(scope: OrgScope): Promise<boolean> {
    const rows = await this.db.all<{ community_enabled: number }>(sql`
      SELECT community_enabled FROM organizations WHERE id = ${scope.organizationId}
    `);
    return (rows[0]?.community_enabled ?? 0) === 1;
  }

  /** Admin moderation feed — all active posts in the org, limit/offset. */
  async adminFeed(
    scope: OrgScope,
    opts: { type?: string; search?: string; limit: number; offset: number },
  ): Promise<PostRow[]> {
    const typeFilter = opts.type ? sql` AND p.type = ${opts.type}` : sql``;
    const search = opts.search
      ? sql` AND (p.title ILIKE ${'%' + opts.search + '%'} OR p.body ILIKE ${'%' + opts.search + '%'})`
      : sql``;
    return this.db.all<PostRow>(sql`
      SELECT p.public_id, p.type, p.title, p.body,
             p.reply_count, p.like_count, p.created_at, p.edited_at,
             ${this.authorColumns('u')},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             false AS liked_by_me
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
   LEFT JOIN certificates cert ON cert.id = p.certificate_id
       WHERE ${orgScope('p', scope)}
         AND p.deleted_at IS NULL
         ${typeFilter}${search}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${opts.limit} OFFSET ${opts.offset}
    `);
  }

  async countForAdmin(
    scope: OrgScope,
    opts: { type?: string; search?: string },
  ): Promise<number> {
    const typeFilter = opts.type ? sql` AND p.type = ${opts.type}` : sql``;
    const search = opts.search
      ? sql` AND (p.title ILIKE ${'%' + opts.search + '%'} OR p.body ILIKE ${'%' + opts.search + '%'})`
      : sql``;
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM community_posts p
       WHERE ${orgScope('p', scope)} AND p.deleted_at IS NULL ${typeFilter}${search}
    `);
    return rows[0]?.n ?? 0;
  }

  /** One post by integer id, org-scoped, with the caller's like state. */
  async getPost(
    scope: OrgScope,
    postId: number,
    userId: number,
  ): Promise<PostRow | null> {
    const rows = await this.db.all<PostRow>(sql`
      SELECT p.public_id, p.type, p.title, p.body,
             p.reply_count, p.like_count, p.created_at, p.edited_at,
             ${this.authorColumns('u')},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             EXISTS (SELECT 1 FROM community_reactions r
                      WHERE r.post_id = p.id AND r.user_id = ${userId}) AS liked_by_me
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
   LEFT JOIN certificates cert ON cert.id = p.certificate_id
       WHERE p.id = ${postId} AND ${orgScope('p', scope)} AND p.deleted_at IS NULL
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async listReplies(
    scope: OrgScope,
    postId: number,
    userId: number,
    opts: { limit: number; offset: number },
  ): Promise<ReplyRow[]> {
    return this.db.all<ReplyRow>(sql`
      SELECT r.id, r.body, r.like_count, r.created_at, r.edited_at,
             ${this.authorColumns('u')},
             EXISTS (SELECT 1 FROM community_reactions rr
                      WHERE rr.reply_id = r.id AND rr.user_id = ${userId}) AS liked_by_me
        FROM community_replies r
        JOIN users u ON u.id = r.user_id
       WHERE r.post_id = ${postId} AND ${orgScope('r', scope)} AND r.deleted_at IS NULL
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT ${opts.limit} OFFSET ${opts.offset}
    `);
  }

  /** Certificate display + ownership check for an achievement post. */
  async certDisplay(
    scope: OrgScope,
    certId: number,
    userId: number,
  ): Promise<CertDisplayRow | null> {
    const rows = await this.db.all<CertDisplayRow>(sql`
      SELECT c.certificate_code, c.journey_id,
             co.name     AS course_name,
             co.session_id,
             j.title     AS journey_name
        FROM certificates c
   LEFT JOIN courses  co ON co.id = c.course_id
   LEFT JOIN journeys j  ON j.id = c.journey_id
       WHERE c.id = ${certId} AND c.user_id = ${userId} AND ${orgScope('c', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async createPost(input: {
    scope: OrgScope;
    userId: number;
    type: string;
    title: string | null;
    body: string | null;
    certificateId: number | null;
  }): Promise<{ id: number; publicId: string }> {
    const rows = await this.db.all<{ id: number; public_id: string }>(sql`
      INSERT INTO community_posts (organization_id, user_id, type, title, body, certificate_id)
      VALUES (${input.scope.organizationId}, ${input.userId}, ${input.type},
              ${input.title}, ${input.body}, ${input.certificateId})
      RETURNING id, public_id
    `);
    return { id: rows[0].id, publicId: rows[0].public_id };
  }

  async createReply(input: {
    scope: OrgScope;
    postId: number;
    userId: number;
    body: string;
  }): Promise<{ id: number }> {
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(communityReplies)
        .values({
          organizationId: input.scope.organizationId,
          postId: input.postId,
          userId: input.userId,
          body: input.body,
        })
        .returning({ id: communityReplies.id });
      await tx
        .update(communityPosts)
        .set({
          replyCount: sql`(SELECT COUNT(*)::int FROM community_replies WHERE post_id = ${input.postId} AND deleted_at IS NULL)`,
        })
        .where(eq(communityPosts.id, input.postId));
      return row.id;
    });
    return { id };
  }

  /** Like a post. Idempotent; returns the fresh count. */
  async likePost(
    scope: OrgScope,
    postId: number,
    userId: number,
  ): Promise<number> {
    await this.db.run(sql`
      INSERT INTO community_reactions (organization_id, user_id, post_id)
      VALUES (${scope.organizationId}, ${userId}, ${postId})
      ON CONFLICT (post_id, user_id) WHERE post_id IS NOT NULL DO NOTHING
    `);
    const rows = await this.db.all<{ like_count: number }>(sql`
      UPDATE community_posts
         SET like_count = (SELECT COUNT(*)::int FROM community_reactions WHERE post_id = ${postId})
       WHERE id = ${postId}
       RETURNING like_count
    `);
    return rows[0]?.like_count ?? 0;
  }

  async unlikePost(postId: number, userId: number): Promise<number> {
    await this.db.run(sql`
      DELETE FROM community_reactions WHERE post_id = ${postId} AND user_id = ${userId}
    `);
    const rows = await this.db.all<{ like_count: number }>(sql`
      UPDATE community_posts
         SET like_count = (SELECT COUNT(*)::int FROM community_reactions WHERE post_id = ${postId})
       WHERE id = ${postId}
       RETURNING like_count
    `);
    return rows[0]?.like_count ?? 0;
  }

  /** Author + type of a post, org-scoped — for ownership and notifications. */
  async findPost(
    scope: OrgScope,
    postId: number,
  ): Promise<{
    id: number;
    publicId: string;
    userId: number;
    type: string;
  } | null> {
    const rows = await this.db.all<{
      id: number;
      public_id: string;
      user_id: number;
      type: string;
    }>(sql`
      SELECT p.id, p.public_id, p.user_id, p.type FROM community_posts p
       WHERE p.id = ${postId} AND ${orgScope('p', scope)} AND p.deleted_at IS NULL
    `);
    return rows[0]
      ? {
          id: rows[0].id,
          publicId: rows[0].public_id,
          userId: rows[0].user_id,
          type: rows[0].type,
        }
      : null;
  }

  async findReply(
    scope: OrgScope,
    replyId: number,
  ): Promise<{ id: number; userId: number; postId: number } | null> {
    const rows = await this.db.all<{ id: number; user_id: number; post_id: number }>(sql`
      SELECT id, user_id, post_id FROM community_replies r
       WHERE id = ${replyId} AND ${orgScope('r', scope)} AND deleted_at IS NULL
    `);
    return rows[0]
      ? { id: rows[0].id, userId: rows[0].user_id, postId: rows[0].post_id }
      : null;
  }

  async softDeletePost(
    scope: OrgScope,
    postId: number,
    byUserId: number,
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE community_posts SET deleted_at = now(), deleted_by = ${byUserId}
       WHERE id = ${postId} AND ${orgScope('community_posts', scope)} AND deleted_at IS NULL
    `);
  }

  async softDeleteReply(
    scope: OrgScope,
    replyId: number,
    postId: number,
    byUserId: number,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(communityReplies)
        .set({ deletedAt: sql`now()`, deletedBy: byUserId })
        .where(eq(communityReplies.id, replyId));
      await tx
        .update(communityPosts)
        .set({
          replyCount: sql`(SELECT COUNT(*)::int FROM community_replies WHERE post_id = ${postId} AND deleted_at IS NULL)`,
        })
        .where(eq(communityPosts.id, postId));
    });
  }
}
