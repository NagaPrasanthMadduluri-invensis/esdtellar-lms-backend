-- 0049_community.sql
--
-- Learning Community: a per-organization social space with three kinds of post
-- (question / achievement / discussion), replies (a question's contributions and
-- an achievement/discussion's comments, one table) and reactions (likes).
--
-- Additive and idempotent. Every row carries organization_id and is read ONLY
-- with orgScope (BACKEND_STRUCTURE.md 10.12) -- community data never crosses a
-- tenant boundary. community_posts.public_id is the URL identity (10.34).
--
-- Also adds organizations.community_enabled (default 1 = on): the per-tenant
-- kill switch, edited on the admin Organization settings screen. Default on so
-- the module is live after deploy; an admin can turn it off.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS community_enabled integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS community_posts (
  id              serial PRIMARY KEY,
  public_id       uuid DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL,
  title           text,
  body            text,
  certificate_id  integer REFERENCES certificates(id) ON DELETE SET NULL,
  reply_count     integer NOT NULL DEFAULT 0,
  like_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by      integer REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS community_posts_public_id_key ON community_posts (public_id);
CREATE INDEX IF NOT EXISTS idx_community_posts_feed     ON community_posts (organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_community_posts_org_type ON community_posts (organization_id, type);
CREATE INDEX IF NOT EXISTS idx_community_posts_user     ON community_posts (user_id);

CREATE TABLE IF NOT EXISTS community_replies (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL,
  post_id         integer NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL,
  like_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by      integer REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_community_replies_post ON community_replies (post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_community_replies_org  ON community_replies (organization_id);

CREATE TABLE IF NOT EXISTS community_reactions (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id         integer REFERENCES community_posts(id) ON DELETE CASCADE,
  reply_id        integer REFERENCES community_replies(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_reactions_one_target CHECK ((post_id IS NOT NULL)::int + (reply_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS community_reactions_post_user  ON community_reactions (post_id, user_id)  WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS community_reactions_reply_user ON community_reactions (reply_id, user_id) WHERE reply_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_community_reactions_org ON community_reactions (organization_id);
