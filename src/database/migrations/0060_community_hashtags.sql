-- 0060_community_hashtags.sql
--
-- Hashtags for community posts. Two tables, per-organization (ACTIVITY, so
-- org-scoped like everything else in the module, section 10.12).
--
--   community_hashtags       one row per distinct tag per org, NORMALISED
--   community_post_hashtags  the join from a post to its tags
--
-- Normalisation is the whole point: the stored `tag` is lower-cased with the
-- leading # stripped, UNIQUE per org, so #Renewables and #renewables are the
-- same tag and never duplicate. `label` keeps the first-seen display casing for
-- the chip. `usage_count` is an approximate popularity signal for autocomplete
-- ordering (incremented on link, not decremented on a post's soft-delete);
-- "all posts with this tag" and trending both read the live join against
-- non-deleted posts, so a deleted post drops out there regardless.

CREATE TABLE IF NOT EXISTS community_hashtags (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL,
  tag             text    NOT NULL,         -- normalised: lower-case, no '#'
  label           text    NOT NULL,         -- first-seen display casing
  usage_count     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS community_hashtags_org_tag
  ON community_hashtags (organization_id, tag);

-- Autocomplete orders by popularity within a tenant.
CREATE INDEX IF NOT EXISTS idx_community_hashtags_usage
  ON community_hashtags (organization_id, usage_count DESC);

CREATE TABLE IF NOT EXISTS community_post_hashtags (
  post_id    integer NOT NULL REFERENCES community_posts (id) ON DELETE CASCADE,
  hashtag_id integer NOT NULL REFERENCES community_hashtags (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

-- "Show every post with this tag" reads by hashtag_id.
CREATE INDEX IF NOT EXISTS idx_community_post_hashtags_tag
  ON community_post_hashtags (hashtag_id);
