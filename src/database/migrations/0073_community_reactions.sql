-- 0073_community_reactions.sql
--
-- Learning Community engagement (owner request 2026-11-23).
--
-- 1. Quick reactions. A community_reactions row gains a KIND: like, helpful,
--    insightful, thanks, great_explanation or agree. The existing unique index
--    (post_id, user_id) is kept, so a person holds ONE reaction per post and
--    choosing another kind replaces it. Every existing row was a heart, so the
--    default backfills them as 'like'. community_posts.like_count stays the
--    TOTAL reaction count (every kind), kept in step by the repository.
--
-- 2. Responding to an answer. A reply may name a parent reply on the same post
--    (one level deep, enforced in the service), so a question's asker can
--    answer a contribution directly under it.
--
-- Additive and idempotent.

ALTER TABLE community_reactions
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'like';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'community_reactions_kind_check'
  ) THEN
    ALTER TABLE community_reactions
      ADD CONSTRAINT community_reactions_kind_check
      CHECK (kind IN ('like', 'helpful', 'insightful', 'thanks', 'great_explanation', 'agree'));
  END IF;
END $$;

ALTER TABLE community_replies
  ADD COLUMN IF NOT EXISTS parent_reply_id integer
  REFERENCES community_replies (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_community_replies_parent
  ON community_replies (parent_reply_id)
  WHERE parent_reply_id IS NOT NULL;
