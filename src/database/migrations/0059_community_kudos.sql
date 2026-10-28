-- 0059_community_kudos.sql
--
-- Kudos: one employee recognises another. A kudos is a community_posts row of
-- type 'kudos' (so it rides the existing feed, likes, replies, soft-delete and
-- moderation, one engine) with a RECIPIENT. `type` is plain text validated in
-- the DTO, so 'kudos' needs no enum change; only the recipient column is new.
--
-- Additive: the column is nullable (every existing post has no recipient) and
-- set only for type='kudos'. ON DELETE SET NULL so removing the recipient's
-- account does not delete the recognition, matching certificate_id's choice.

ALTER TABLE community_posts
  ADD COLUMN IF NOT EXISTS recipient_user_id integer REFERENCES users (id) ON DELETE SET NULL;

-- The Kudos leaderboard and a recipient's own kudos count both read this.
CREATE INDEX IF NOT EXISTS idx_community_posts_recipient
  ON community_posts (organization_id, recipient_user_id);
