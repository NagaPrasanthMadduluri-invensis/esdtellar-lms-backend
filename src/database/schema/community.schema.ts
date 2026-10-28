import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { certificates } from './certificates.schema';
import { users } from './users.schema';

/**
 * Learning Community (0049). A per-organization social space with three kinds
 * of post — question, achievement, discussion.
 *
 * Everything here is ACTIVITY, owned by one tenant, so `organization_id` is on
 * every row and every read is `orgScope` (never `contentScope`, §10.12): a
 * post, reply or like NEVER crosses a tenant boundary. `organization_id` is a
 * plain integer (not a Drizzle FK), matching `certificates` and the rest of
 * the activity tables.
 *
 * A reply serves BOTH a question's "contributions" (answers) and an
 * achievement/discussion's "comments" — one table, relabelled by `post.type`
 * in the UI, so there is one engine to keep in sync. A reaction is a "like";
 * it is shaped to sit on a post (v1) or a reply (v1.1 answer up-votes) via the
 * "exactly one of" pattern (§10.11).
 */
export const communityPosts = pgTable(
  'community_posts',
  {
    id: serial('id').primaryKey(),
    // URL-exposed (/community/<public_id>), so a non-sequential id (§10.34).
    publicId: uuid('public_id').defaultRandom(),
    organizationId: integer('organization_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 'question' | 'achievement' | 'discussion'
    type: text('type').notNull(),
    // title: required for question/discussion, null for an achievement post.
    title: text('title'),
    // body: the question / discussion / achievement caption.
    body: text('body'),
    // Set ONLY for type='achievement'; the shared certificate. Owner + org are
    // validated in the service. ON DELETE SET NULL so removing a cert does not
    // destroy the post.
    certificateId: integer('certificate_id').references(() => certificates.id, {
      onDelete: 'set null',
    }),
    // Set ONLY for type='kudos' (0059): the person being recognised. The giver
    // is `user_id`, the message is `body`. ON DELETE SET NULL so removing the
    // recipient's account does not delete the recognition.
    recipientUserId: integer('recipient_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // The group this post belongs to (0061), or NULL for the main feed. A post
    // lives in exactly one place. ON DELETE CASCADE with the group.
    groupId: integer('group_id'),
    // Denormalised counters, kept in step with the insert/delete in one
    // transaction, so the feed never counts rows per card (§7.1).
    replyCount: integer('reply_count').notNull().default(0),
    likeCount: integer('like_count').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp('edited_at', { mode: 'string', withTimezone: true }),
    // Soft delete: the author or a moderator removes a post; the row stays for
    // audit and is hidden everywhere.
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
    deletedBy: integer('deleted_by').references(() => users.id),
  },
  (table) => [
    uniqueIndex('community_posts_public_id_key').on(table.publicId),
    index('idx_community_posts_feed').on(table.organizationId, table.createdAt),
    index('idx_community_posts_org_type').on(table.organizationId, table.type),
    index('idx_community_posts_user').on(table.userId),
    index('idx_community_posts_recipient').on(
      table.organizationId,
      table.recipientUserId,
    ),
  ],
);

/**
 * Hashtags (0060). Per-organization, NORMALISED so #Renewables and #renewables
 * are one tag. `tag` is lower-cased with the leading # stripped and unique per
 * org; `label` keeps the first-seen display casing. `usage_count` is an
 * approximate popularity signal for autocomplete ordering.
 */
export const communityHashtags = pgTable(
  'community_hashtags',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    tag: text('tag').notNull(),
    label: text('label').notNull(),
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('community_hashtags_org_tag').on(table.organizationId, table.tag),
    index('idx_community_hashtags_usage').on(table.organizationId, table.usageCount),
  ],
);

export const communityPostHashtags = pgTable(
  'community_post_hashtags',
  {
    postId: integer('post_id')
      .notNull()
      .references(() => communityPosts.id, { onDelete: 'cascade' }),
    hashtagId: integer('hashtag_id')
      .notNull()
      .references(() => communityHashtags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.postId, table.hashtagId] }),
    index('idx_community_post_hashtags_tag').on(table.hashtagId),
  ],
);

export const communityReplies = pgTable(
  'community_replies',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    postId: integer('post_id')
      .notNull()
      .references(() => communityPosts.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    likeCount: integer('like_count').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    editedAt: timestamp('edited_at', { mode: 'string', withTimezone: true }),
    deletedAt: timestamp('deleted_at', { mode: 'string', withTimezone: true }),
    deletedBy: integer('deleted_by').references(() => users.id),
  },
  (table) => [
    index('idx_community_replies_post').on(table.postId, table.createdAt),
    index('idx_community_replies_org').on(table.organizationId),
  ],
);

export const communityReactions = pgTable(
  'community_reactions',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    postId: integer('post_id').references(() => communityPosts.id, {
      onDelete: 'cascade',
    }),
    replyId: integer('reply_id').references(() => communityReplies.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Exactly one target (§10.11): a reaction likes a post OR a reply.
    check(
      'community_reactions_one_target',
      sql`(${table.postId} IS NOT NULL)::int + (${table.replyId} IS NOT NULL)::int = 1`,
    ),
    uniqueIndex('community_reactions_post_user')
      .on(table.postId, table.userId)
      .where(sql`${table.postId} IS NOT NULL`),
    uniqueIndex('community_reactions_reply_user')
      .on(table.replyId, table.userId)
      .where(sql`${table.replyId} IS NOT NULL`),
    index('idx_community_reactions_org').on(table.organizationId),
  ],
);

export type CommunityPostRow = typeof communityPosts.$inferSelect;
export type NewCommunityPostRow = typeof communityPosts.$inferInsert;
export type CommunityReplyRow = typeof communityReplies.$inferSelect;
export type NewCommunityReplyRow = typeof communityReplies.$inferInsert;
export type CommunityReactionRow = typeof communityReactions.$inferSelect;
export type NewCommunityReactionRow = typeof communityReactions.$inferInsert;
export type CommunityHashtagRow = typeof communityHashtags.$inferSelect;
export type NewCommunityHashtagRow = typeof communityHashtags.$inferInsert;
export type CommunityPostHashtagRow = typeof communityPostHashtags.$inferSelect;

/**
 * Groups (0061): admin-created sub-communities. A learner joins; posts carry a
 * `group_id` (above) that is NULL for the main feed or set for a group's feed.
 */
export const communityGroups = pgTable(
  'community_groups',
  {
    id: serial('id').primaryKey(),
    publicId: uuid('public_id').defaultRandom(),
    organizationId: integer('organization_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    archivedAt: timestamp('archived_at', { mode: 'string', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('community_groups_public_id_key').on(table.publicId),
    index('idx_community_groups_org').on(table.organizationId, table.archivedAt),
  ],
);

export const communityGroupMembers = pgTable(
  'community_group_members',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => communityGroups.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: integer('organization_id').notNull(),
    joinedAt: timestamp('joined_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.userId] }),
    index('idx_community_group_members_user').on(table.userId),
  ],
);

export type CommunityGroupRow = typeof communityGroups.$inferSelect;
export type NewCommunityGroupRow = typeof communityGroups.$inferInsert;
export type CommunityGroupMemberRow = typeof communityGroupMembers.$inferSelect;
