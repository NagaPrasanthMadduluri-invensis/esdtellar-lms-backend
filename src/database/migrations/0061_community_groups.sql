-- 0061_community_groups.sql
--
-- Community Groups: admin-created sub-communities within one org's community, a
-- learner JOINS, each with its own feed. Plus a group_id on posts so a post
-- lives EITHER in the main feed (group_id NULL) or in exactly one group.
--
-- ACTIVITY, so org-scoped like the rest of the module (section 10.35). Groups
-- are created by an admin (moderate_community); joining is self-serve for a
-- learner. A group's feed is visible to the org; POSTING into it requires
-- membership, checked in the service.

CREATE TABLE IF NOT EXISTS community_groups (
  id              serial PRIMARY KEY,
  -- URL-addressable (?group=<public_id>), so a non-sequential id (section 10.34).
  public_id       uuid DEFAULT gen_random_uuid(),
  organization_id integer NOT NULL,
  name            text    NOT NULL,
  description     text,
  created_by      integer REFERENCES users (id) ON DELETE SET NULL,
  -- Soft-remove, like a post: an archived group drops out of the lists but its
  -- history survives. There is no hard-delete route.
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS community_groups_public_id_key
  ON community_groups (public_id);
CREATE INDEX IF NOT EXISTS idx_community_groups_org
  ON community_groups (organization_id, archived_at);

CREATE TABLE IF NOT EXISTS community_group_members (
  group_id        integer NOT NULL REFERENCES community_groups (id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id integer NOT NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- "Which groups am I in" reads by user.
CREATE INDEX IF NOT EXISTS idx_community_group_members_user
  ON community_group_members (user_id);

-- A post belongs to one group, or to the main feed when NULL. ON DELETE CASCADE
-- so removing a group takes its posts (archive is the non-destructive path).
ALTER TABLE community_posts
  ADD COLUMN IF NOT EXISTS group_id integer REFERENCES community_groups (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_community_posts_group
  ON community_posts (group_id, created_at);
