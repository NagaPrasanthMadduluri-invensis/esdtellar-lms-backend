-- 0055_user_last_seen.sql
--
-- Presence: when a person was last seen making an authenticated request. The
-- Messages thread header shows a green "Available" dot when this is recent and
-- "Active <relative> ago" otherwise. Additive and idempotent; nullable, so
-- every existing row starts with no last-seen and simply reads as away until
-- the person's next request touches it.
--
-- It is NOT last learning activity (users have that derived from completions
-- and attempts) -- this is updated on ANY authenticated request, throttled, so
-- "Available" means around now, not "finished a lesson recently".

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
