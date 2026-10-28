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
  hashtags: { tag: string; label: string }[] | null;
  // Set only for a kudos post (type='kudos') — the person recognised, shown as
  // first name + last initial like every other community surface.
  recipient_first_name: string | null;
  recipient_last_initial: string | null;
  recipient_avatar: string | null;
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

  // A post's hashtags as a JSON array of {tag,label}, ordered for display.
  // `[]` when it has none, so the client never guards on null.
  private hashtagsJson(postAlias: string) {
    const p = sql.identifier(postAlias);
    return sql`COALESCE((
      SELECT json_agg(json_build_object('tag', h.tag, 'label', h.label) ORDER BY h.label)
        FROM community_post_hashtags ph
        JOIN community_hashtags h ON h.id = ph.hashtag_id
       WHERE ph.post_id = ${p}.id
    ), '[]'::json) AS hashtags`;
  }

  // The kudos recipient (joined as `ru`), first name + last initial like the
  // author columns. Null on every non-kudos post.
  private recipientColumns() {
    return sql`
      ru.first_name AS recipient_first_name,
      NULLIF(UPPER(LEFT(TRIM(ru.last_name), 1)), '') AS recipient_last_initial,
      ru.avatar_url AS recipient_avatar`;
  }

  /** The feed — one org, newest first, keyset-paginated, deleted hidden. */
  async feedFor(
    scope: OrgScope,
    userId: number,
    opts: {
      type?: string;
      hashtag?: string;
      cursorTs?: string;
      cursorId?: number;
      limit: number;
    },
  ): Promise<PostRow[]> {
    const typeFilter = opts.type ? sql` AND p.type = ${opts.type}` : sql``;
    const hashtagFilter = opts.hashtag
      ? sql` AND EXISTS (SELECT 1 FROM community_post_hashtags ph
                           JOIN community_hashtags h ON h.id = ph.hashtag_id
                          WHERE ph.post_id = p.id
                            AND ${orgScope('h', scope)} AND h.tag = ${opts.hashtag})`
      : sql``;
    const cursor =
      opts.cursorTs && opts.cursorId !== undefined
        ? sql` AND (p.created_at, p.id) < (${opts.cursorTs}, ${opts.cursorId})`
        : sql``;
    return this.db.all<PostRow>(sql`
      SELECT p.id AS post_pk, p.public_id, p.type, p.title, p.body,
             p.reply_count, p.like_count, p.created_at, p.edited_at,
             ${this.authorColumns('u')},
             ${this.recipientColumns()},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             ${this.hashtagsJson('p')},
             EXISTS (SELECT 1 FROM community_reactions r
                      WHERE r.post_id = p.id AND r.user_id = ${userId}) AS liked_by_me
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
   LEFT JOIN users ru ON ru.id = p.recipient_user_id
   LEFT JOIN certificates cert ON cert.id = p.certificate_id
       WHERE ${orgScope('p', scope)}
         AND p.deleted_at IS NULL
         ${typeFilter}${hashtagFilter}${cursor}
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
             ${this.recipientColumns()},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             ${this.hashtagsJson('p')},
             false AS liked_by_me
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
   LEFT JOIN users ru ON ru.id = p.recipient_user_id
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
             ${this.recipientColumns()},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             ${this.hashtagsJson('p')},
             EXISTS (SELECT 1 FROM community_reactions r
                      WHERE r.post_id = p.id AND r.user_id = ${userId}) AS liked_by_me
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
   LEFT JOIN users ru ON ru.id = p.recipient_user_id
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
    recipientUserId?: number | null;
  }): Promise<{ id: number; publicId: string }> {
    const rows = await this.db.all<{ id: number; public_id: string }>(sql`
      INSERT INTO community_posts
        (organization_id, user_id, type, title, body, certificate_id, recipient_user_id)
      VALUES (${input.scope.organizationId}, ${input.userId}, ${input.type},
              ${input.title}, ${input.body}, ${input.certificateId},
              ${input.recipientUserId ?? null})
      RETURNING id, public_id
    `);
    return { id: rows[0].id, publicId: rows[0].public_id };
  }

  // ── Hashtags ──────────────────────────────────────────────────────────────

  /**
   * Upsert the tags for this org and return their ids. One statement per call
   * (not per tag): a VALUES list, ON CONFLICT bumps usage_count and keeps the
   * first-seen label. The normalised `tag`/`label` pairs come from the service.
   */
  async upsertHashtags(
    scope: OrgScope,
    tags: { tag: string; label: string }[],
  ): Promise<number[]> {
    if (tags.length === 0) return [];
    const values = sql.join(
      tags.map(
        (t) => sql`(${scope.organizationId}, ${t.tag}, ${t.label}, 1)`,
      ),
      sql`, `,
    );
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO community_hashtags (organization_id, tag, label, usage_count)
      VALUES ${values}
      ON CONFLICT (organization_id, tag)
        DO UPDATE SET usage_count = community_hashtags.usage_count + 1
      RETURNING id
    `);
    return rows.map((r) => r.id);
  }

  /** Link a post to its hashtag ids. One multi-row insert (§7.1). */
  async linkPostHashtags(postId: number, hashtagIds: number[]): Promise<void> {
    if (hashtagIds.length === 0) return;
    const values = sql.join(
      hashtagIds.map((id) => sql`(${postId}, ${id})`),
      sql`, `,
    );
    await this.db.run(sql`
      INSERT INTO community_post_hashtags (post_id, hashtag_id)
      VALUES ${values}
      ON CONFLICT DO NOTHING
    `);
  }

  /** Autocomplete: tags whose normalised form starts with `q`, popular first. */
  async suggestHashtags(scope: OrgScope, q: string, limit: number) {
    return this.db.all<{ tag: string; label: string; count: number }>(sql`
      SELECT tag, label, usage_count AS count
        FROM community_hashtags
       WHERE ${orgScope('community_hashtags', scope)} AND tag LIKE ${q + '%'}
       ORDER BY usage_count DESC, tag ASC
       LIMIT ${limit}
    `);
  }

  /**
   * Trending: tags on the most non-deleted posts in the recent window. Read
   * from the live join, so a deleted post never counts — `usage_count` is only
   * an autocomplete hint and is deliberately not used here.
   */
  async trendingHashtags(scope: OrgScope, days: number, limit: number) {
    return this.db.all<{ tag: string; label: string; count: number }>(sql`
      SELECT h.tag, h.label, COUNT(*)::int AS count
        FROM community_post_hashtags ph
        JOIN community_hashtags h ON h.id = ph.hashtag_id
        JOIN community_posts p ON p.id = ph.post_id
       WHERE ${orgScope('h', scope)}
         AND p.deleted_at IS NULL
         AND p.created_at >= now() - (${days} || ' days')::interval
       GROUP BY h.id, h.tag, h.label
       ORDER BY count DESC, h.tag ASC
       LIMIT ${limit}
    `);
  }

  // ── Kudos + people ────────────────────────────────────────────────────────

  /**
   * Is this user a valid kudos recipient — an ACTIVE learner-portal account in
   * the caller's org? Org-scoped, so a cross-tenant id resolves to nothing.
   */
  async isKudosRecipient(scope: OrgScope, userId: number): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM users u
        JOIN roles r ON r.id = u.role_id
       WHERE u.id = ${userId}
         AND ${orgScope('u', scope)}
         AND u.is_active = 1
         AND r.portal = 'learner'
    `);
    return (rows[0]?.n ?? 0) > 0;
  }

  /** People search for the kudos picker — active learner-portal users, not the
   *  caller. Full name + dept here (the giver is choosing a specific person). */
  async searchPeople(
    scope: OrgScope,
    q: string | undefined,
    excludeUserId: number,
    limit: number,
  ) {
    const search = q
      ? sql` AND (u.first_name ILIKE ${'%' + q + '%'}
                   OR u.last_name ILIKE ${'%' + q + '%'}
                   OR TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) ILIKE ${'%' + q + '%'})`
      : sql``;
    return this.db.all<{
      id: number;
      name: string;
      department: string | null;
      avatar_url: string | null;
    }>(sql`
      SELECT u.id,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name,
             u.department,
             u.avatar_url
        FROM users u
        JOIN roles r ON r.id = u.role_id
       WHERE ${orgScope('u', scope)}
         AND u.is_active = 1
         AND r.portal = 'learner'
         AND u.id <> ${excludeUserId}
         ${search}
       ORDER BY name ASC
       LIMIT ${limit}
    `);
  }

  /** A learner's own kudos: the count received and the most recent few. */
  async kudosForUser(scope: OrgScope, userId: number, recentLimit: number) {
    const countRows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM community_posts p
       WHERE ${orgScope('p', scope)} AND p.type = 'kudos'
         AND p.recipient_user_id = ${userId} AND p.deleted_at IS NULL
    `);
    const recent = await this.db.all<{
      public_id: string;
      body: string | null;
      created_at: string;
      first_name: string;
      last_initial: string | null;
      avatar_url: string | null;
    }>(sql`
      SELECT p.public_id, p.body, p.created_at,
             u.first_name,
             NULLIF(UPPER(LEFT(TRIM(u.last_name), 1)), '') AS last_initial,
             u.avatar_url
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
       WHERE ${orgScope('p', scope)} AND p.type = 'kudos'
         AND p.recipient_user_id = ${userId} AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${recentLimit}
    `);
    return { received: countRows[0]?.n ?? 0, recent };
  }

  /** The Kudos leaderboard — recipients ranked by kudos received, org-scoped. */
  async kudosLeaderboard(scope: OrgScope, limit: number) {
    return this.db.all<{
      user_id: number;
      first_name: string;
      last_initial: string | null;
      department: string | null;
      avatar_url: string | null;
      received: number;
    }>(sql`
      SELECT u.id AS user_id, u.first_name,
             NULLIF(UPPER(LEFT(TRIM(u.last_name), 1)), '') AS last_initial,
             u.department, u.avatar_url,
             COUNT(*)::int AS received
        FROM community_posts p
        JOIN users u ON u.id = p.recipient_user_id
       WHERE ${orgScope('p', scope)} AND p.type = 'kudos'
         AND p.deleted_at IS NULL AND u.is_active = 1
       GROUP BY u.id, u.first_name, u.last_name, u.department, u.avatar_url
       ORDER BY received DESC, u.first_name ASC
       LIMIT ${limit}
    `);
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

  /**
   * Who liked a post — newest first, org-scoped on the reaction so a like never
   * crosses a tenant. Returns the same author columns the feed uses, so the
   * caller shows first name + last initial on the learner surface (§10.24).
   */
  async postLikers(scope: OrgScope, postId: number, limit: number) {
    return this.db.all<{
      author_id: number;
      first_name: string;
      last_initial: string | null;
      author_name: string;
      author_email: string | null;
      avatar_url: string | null;
      created_at: string;
    }>(sql`
      SELECT ${this.authorColumns('u')}, cr.created_at
      FROM community_reactions cr
      JOIN users u ON u.id = cr.user_id
      WHERE cr.post_id = ${postId} AND ${orgScope('cr', scope)}
      ORDER BY cr.created_at DESC
      LIMIT ${limit}
    `);
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
