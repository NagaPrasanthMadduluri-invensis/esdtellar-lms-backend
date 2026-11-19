-- 0072_engagement.sql — engagement-hours tracking (owner request 2026-11-19).
--
-- Engagement is ACTIVE time on the platform: the client credits seconds only
-- while the cursor/keyboard is moving and stops after 5 minutes of no movement
-- (idle is not engagement). It is a NEW, ADDITIVE metric compared against the
-- §10.4 learning hours (completion-credited time), which are unchanged.
--
-- One row per (user, day). The client posts short batches of active seconds to
-- POST /api/engagement/ping; this table accumulates them, capped at a day.
-- ACTIVITY, so orgScope on every read.

CREATE TABLE IF NOT EXISTS engagement_daily (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day             date NOT NULL,
  active_seconds  integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One accumulator per person per day; the ping upserts onto it.
CREATE UNIQUE INDEX IF NOT EXISTS engagement_daily_user_day_key
  ON engagement_daily (user_id, day);

-- The per-period org and learner trend reads filter by org and bucket by day.
CREATE INDEX IF NOT EXISTS idx_engagement_daily_org_day
  ON engagement_daily (organization_id, day);
