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
  // 'admin' | 'learner' | 'trainer': lets the UI mark an L&D participant.
  author_portal: string | null;
  cert_public_id: string | null;
  cert_code: string | null;
  cert_revoked: number | null;
  liked_by_me: boolean;
  // The caller's one quick reaction on the post, or null (0073).
  my_reaction: string | null;
  // {kind: count} for the kinds used on the post; `{}` when none.
  reaction_counts: Record<string, number> | null;
  hashtags: { tag: string; label: string }[] | null;
  // Set only for a kudos post (type='kudos') — the person recognised, shown as
  // first name + last initial like every other community surface.
  recipient_first_name: string | null;
  recipient_last_initial: string | null;
  recipient_avatar: string | null;
  // Set only for a resource post (type='resource'). file_path is NOT selected
  // into the feed — it is internal; the file is fetched via the post's route.
  resource_url: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
}

export interface ReplyRow {
  id: number;
  // The reply this one responds to (0073), or null for a top-level reply.
  parent_reply_id: number | null;
  body: string;
  like_count: number;
  created_at: string;
  edited_at: string | null;
  author_id: number;
  first_name: string;
  last_initial: string | null;
  author_name: string;
  avatar_url: string | null;
  author_portal: string | null;
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
      ${a}.avatar_url,
      (SELECT ro.portal FROM roles ro WHERE ro.id = ${a}.role_id) AS author_portal`;
  }

  // The caller's quick reaction and the per-kind breakdown for a post (0073).
  // Both ride the (post_id, user_id) unique index, one correlated read each.
  private reactionColumns(postAlias: string, userId: number) {
    const p = sql.identifier(postAlias);
    return sql`
      EXISTS (SELECT 1 FROM community_reactions r
               WHERE r.post_id = ${p}.id AND r.user_id = ${userId}) AS liked_by_me,
      (SELECT r.kind FROM community_reactions r
        WHERE r.post_id = ${p}.id AND r.user_id = ${userId} LIMIT 1) AS my_reaction,
      COALESCE((
        SELECT json_object_agg(x.kind, x.n)
          FROM (SELECT r.kind, COUNT(*)::int AS n
                  FROM community_reactions r
                 WHERE r.post_id = ${p}.id
                 GROUP BY r.kind) x
      ), '{}'::json) AS reaction_counts`;
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

  // A resource post's attachment, for the feed. `file_path` is NOT here — it is
  // internal; the file is streamed by the post's own route after a check.
  private resourceColumns(postAlias: string) {
    const p = sql.identifier(postAlias);
    return sql`${p}.resource_url, ${p}.file_name, ${p}.file_mime, ${p}.file_size`;
  }

  /** The feed — one org, newest first, keyset-paginated, deleted hidden. */
  async feedFor(
    scope: OrgScope,
    userId: number,
    opts: {
      type?: string;
      hashtag?: string;
      groupId?: number;
      cursorTs?: string;
      cursorId?: number;
      limit: number;
    },
  ): Promise<PostRow[]> {
    const typeFilter = opts.type ? sql` AND p.type = ${opts.type}` : sql``;
    // A post lives in one place: the main feed (group_id NULL) or one group.
    const groupFilter =
      opts.groupId !== undefined
        ? sql` AND p.group_id = ${opts.groupId}`
        : sql` AND p.group_id IS NULL`;
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
             ${this.resourceColumns('p')},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             ${this.hashtagsJson('p')},
             ${this.reactionColumns('p', userId)}
        FROM community_posts p
        JOIN users u ON u.id = p.user_id
   LEFT JOIN users ru ON ru.id = p.recipient_user_id
   LEFT JOIN certificates cert ON cert.id = p.certificate_id
       WHERE ${orgScope('p', scope)}
         AND p.deleted_at IS NULL
         ${typeFilter}${hashtagFilter}${groupFilter}${cursor}
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
    userId: number,
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
             ${this.resourceColumns('p')},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             ${this.hashtagsJson('p')},
             ${this.reactionColumns('p', userId)}
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
             ${this.resourceColumns('p')},
             cert.public_id        AS cert_public_id,
             cert.certificate_code AS cert_code,
             cert.is_revoked       AS cert_revoked,
             ${this.hashtagsJson('p')},
             ${this.reactionColumns('p', userId)}
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
      SELECT r.id, r.parent_reply_id, r.body, r.like_count, r.created_at, r.edited_at,
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
    groupId?: number | null;
    resource?: {
      url?: string | null;
      filePath?: string | null;
      fileName?: string | null;
      fileMime?: string | null;
      fileSize?: number | null;
    } | null;
  }): Promise<{ id: number; publicId: string }> {
    const r = input.resource ?? {};
    const rows = await this.db.all<{ id: number; public_id: string }>(sql`
      INSERT INTO community_posts
        (organization_id, user_id, type, title, body, certificate_id, recipient_user_id, group_id,
         resource_url, file_path, file_name, file_mime, file_size)
      VALUES (${input.scope.organizationId}, ${input.userId}, ${input.type},
              ${input.title}, ${input.body}, ${input.certificateId},
              ${input.recipientUserId ?? null}, ${input.groupId ?? null},
              ${r.url ?? null}, ${r.filePath ?? null}, ${r.fileName ?? null},
              ${r.fileMime ?? null}, ${r.fileSize ?? null})
      RETURNING id, public_id
    `);
    return { id: rows[0].id, publicId: rows[0].public_id };
  }

  /** A resource post's stored file, org-scoped — for the download route. */
  async findPostFile(scope: OrgScope, postId: number) {
    const rows = await this.db.all<{
      file_path: string | null;
      file_name: string | null;
      file_mime: string | null;
    }>(sql`
      SELECT file_path, file_name, file_mime FROM community_posts p
       WHERE p.id = ${postId} AND ${orgScope('p', scope)} AND p.deleted_at IS NULL
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  // ── Groups ──────────────────────────────────────────────────────────────────

  async createGroup(input: {
    scope: OrgScope;
    name: string;
    description: string | null;
    createdBy: number;
  }): Promise<{ id: number; public_id: string }> {
    const rows = await this.db.all<{ id: number; public_id: string }>(sql`
      INSERT INTO community_groups (organization_id, name, description, created_by)
      VALUES (${input.scope.organizationId}, ${input.name}, ${input.description}, ${input.createdBy})
      RETURNING id, public_id
    `);
    return rows[0];
  }

  async updateGroup(
    scope: OrgScope,
    id: number,
    patch: { name?: string; description?: string | null; archived?: boolean },
  ): Promise<void> {
    const sets = [];
    if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
    if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`);
    if (patch.archived !== undefined) {
      sets.push(patch.archived ? sql`archived_at = now()` : sql`archived_at = NULL`);
    }
    if (sets.length === 0) return;
    await this.db.run(sql`
      UPDATE community_groups SET ${sql.join(sets, sql`, `)}
       WHERE id = ${id} AND ${orgScope('community_groups', scope)}
    `);
  }

  /** A group row, org-scoped — for ownership/existence checks. */
  async findGroup(scope: OrgScope, id: number) {
    const rows = await this.db.all<{
      id: number;
      public_id: string;
      name: string;
      description: string | null;
      archived_at: string | null;
    }>(sql`
      SELECT id, public_id, name, description, archived_at
        FROM community_groups
       WHERE id = ${id} AND ${orgScope('community_groups', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Groups for a learner: active ones, with member + post counts and whether
   *  the caller has joined. */
  async listGroupsForLearner(scope: OrgScope, userId: number) {
    return this.db.all<{
      id: number;
      public_id: string;
      name: string;
      description: string | null;
      member_count: number;
      post_count: number;
      joined: boolean;
    }>(sql`
      SELECT g.id, g.public_id, g.name, g.description,
             (SELECT COUNT(*)::int FROM community_group_members m WHERE m.group_id = g.id) AS member_count,
             (SELECT COUNT(*)::int FROM community_posts p WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS post_count,
             EXISTS (SELECT 1 FROM community_group_members m WHERE m.group_id = g.id AND m.user_id = ${userId}) AS joined
        FROM community_groups g
       WHERE ${orgScope('g', scope)} AND g.archived_at IS NULL
       ORDER BY g.name ASC
    `);
  }

  /** Groups for the admin manager: all (including archived), with counts. */
  async listGroupsForAdmin(scope: OrgScope) {
    return this.db.all<{
      id: number;
      public_id: string;
      name: string;
      description: string | null;
      archived: boolean;
      member_count: number;
      post_count: number;
    }>(sql`
      SELECT g.id, g.public_id, g.name, g.description,
             (g.archived_at IS NOT NULL) AS archived,
             (SELECT COUNT(*)::int FROM community_group_members m WHERE m.group_id = g.id) AS member_count,
             (SELECT COUNT(*)::int FROM community_posts p WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS post_count
        FROM community_groups g
       WHERE ${orgScope('g', scope)}
       ORDER BY (g.archived_at IS NOT NULL) ASC, g.name ASC
    `);
  }

  async isGroupMember(groupId: number, userId: number): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM community_group_members
       WHERE group_id = ${groupId} AND user_id = ${userId}
    `);
    return (rows[0]?.n ?? 0) > 0;
  }

  async joinGroup(scope: OrgScope, groupId: number, userId: number): Promise<void> {
    await this.db.run(sql`
      INSERT INTO community_group_members (group_id, user_id, organization_id)
      VALUES (${groupId}, ${userId}, ${scope.organizationId})
      ON CONFLICT (group_id, user_id) DO NOTHING
    `);
  }

  async leaveGroup(groupId: number, userId: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM community_group_members WHERE group_id = ${groupId} AND user_id = ${userId}
    `);
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
  /**
   * Most kudos received. A learner who opted out of leaderboards (0064) is
   * left out: the kudos board is a ranking like any other. The kudos posts
   * themselves stay in the feed, which is community content, not a ranking.
   */
  async kudosLeaderboard(scope: OrgScope, limit: number) {
    return this.db.all<{
      user_id: number;
      first_name: string;
      last_name: string;
      department: string | null;
      avatar_url: string | null;
      received: number;
    }>(sql`
      SELECT u.id AS user_id, u.first_name, u.last_name,
             u.department, u.avatar_url,
             COUNT(*)::int AS received
        FROM community_posts p
        JOIN users u ON u.id = p.recipient_user_id
       WHERE ${orgScope('p', scope)} AND p.type = 'kudos'
         AND p.deleted_at IS NULL AND u.is_active = 1
         AND u.leaderboard_hidden = 0
       GROUP BY u.id, u.first_name, u.last_name, u.department, u.avatar_url
       ORDER BY received DESC, u.first_name ASC
       LIMIT ${limit}
    `);
  }

  /** The organization's leaderboard switch and name display (0064). */
  async leaderboardSettings(
    scope: OrgScope,
  ): Promise<{ leaderboard_enabled: number; leaderboard_name_display: string }> {
    const rows = await this.db.all<{
      leaderboard_enabled: number;
      leaderboard_name_display: string;
    }>(sql`
      SELECT leaderboard_enabled, leaderboard_name_display
        FROM organizations
       WHERE id = ${scope.organizationId}
    `);
    return rows[0] ?? { leaderboard_enabled: 1, leaderboard_name_display: 'initial' };
  }

  async createReply(input: {
    scope: OrgScope;
    postId: number;
    userId: number;
    body: string;
    parentReplyId?: number | null;
  }): Promise<{ id: number }> {
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(communityReplies)
        .values({
          organizationId: input.scope.organizationId,
          postId: input.postId,
          userId: input.userId,
          body: input.body,
          parentReplyId: input.parentReplyId ?? null,
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

  /**
   * Set the caller's one reaction on a post (0073). Idempotent: the unique
   * (post_id, user_id) index means a second call CHANGES the kind rather than
   * adding a row, so nobody is counted twice. The total is recounted in the
   * same transaction. Returns the fresh total and per-kind breakdown.
   */
  async setPostReaction(
    scope: OrgScope,
    postId: number,
    userId: number,
    kind: string,
  ): Promise<{ total: number; counts: Record<string, number> }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO community_reactions (organization_id, user_id, post_id, kind)
        VALUES (${scope.organizationId}, ${userId}, ${postId}, ${kind})
        ON CONFLICT (post_id, user_id) WHERE post_id IS NOT NULL
          DO UPDATE SET kind = EXCLUDED.kind
      `);
      return this.recountPost(tx, postId);
    });
  }

  /** Remove the caller's reaction, whatever its kind. Idempotent. */
  async removePostReaction(
    postId: number,
    userId: number,
  ): Promise<{ total: number; counts: Record<string, number> }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        DELETE FROM community_reactions WHERE post_id = ${postId} AND user_id = ${userId}
      `);
      return this.recountPost(tx, postId);
    });
  }

  // Recount like_count (all kinds) and read the breakdown, inside the caller's
  // transaction so the counter and the rows never disagree.
  private async recountPost(
    tx: Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0],
    postId: number,
  ): Promise<{ total: number; counts: Record<string, number> }> {
    const res = await tx.execute(sql`
      WITH counts AS (
        SELECT kind, COUNT(*)::int AS n FROM community_reactions
         WHERE post_id = ${postId} GROUP BY kind
      ), upd AS (
        UPDATE community_posts
           SET like_count = (SELECT COALESCE(SUM(n), 0)::int FROM counts)
         WHERE id = ${postId}
     RETURNING like_count
      )
      SELECT (SELECT like_count FROM upd) AS total,
             COALESCE((SELECT json_object_agg(kind, n) FROM counts), '{}'::json) AS counts
    `);
    const row = (res as unknown as { rows: { total: number; counts: Record<string, number> }[] })
      .rows[0];
    return { total: row?.total ?? 0, counts: row?.counts ?? {} };
  }

  /**
   * Who reacted to a post, and with what: newest first, org-scoped on the
   * reaction so it never crosses a tenant. Carries the author columns plus
   * department, so the learner surface shows first name + last initial
   * (§10.24) and the admin surface the full participant record.
   */
  async postReactors(scope: OrgScope, postId: number, limit: number) {
    return this.db.all<{
      author_id: number;
      first_name: string;
      last_initial: string | null;
      author_name: string;
      author_email: string | null;
      avatar_url: string | null;
      author_portal: string | null;
      department: string | null;
      kind: string;
      created_at: string;
    }>(sql`
      SELECT ${this.authorColumns('u')}, u.department, cr.kind, cr.created_at
      FROM community_reactions cr
      JOIN users u ON u.id = cr.user_id
      WHERE cr.post_id = ${postId} AND ${orgScope('cr', scope)}
      ORDER BY cr.created_at DESC, cr.id DESC
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
  ): Promise<{
    id: number;
    userId: number;
    postId: number;
    parentReplyId: number | null;
  } | null> {
    const rows = await this.db.all<{
      id: number;
      user_id: number;
      post_id: number;
      parent_reply_id: number | null;
    }>(sql`
      SELECT id, user_id, post_id, parent_reply_id FROM community_replies r
       WHERE id = ${replyId} AND ${orgScope('r', scope)} AND deleted_at IS NULL
    `);
    return rows[0]
      ? {
          id: rows[0].id,
          userId: rows[0].user_id,
          postId: rows[0].post_id,
          parentReplyId: rows[0].parent_reply_id,
        }
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
