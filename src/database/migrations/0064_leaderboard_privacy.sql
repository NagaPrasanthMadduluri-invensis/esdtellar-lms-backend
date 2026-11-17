-- Leaderboard privacy (PDPA readiness, gamification). Three controls over what
-- colleagues can see on the leaderboard, decided with the owner 2026-11-17.
--
-- users.leaderboard_hidden
--   A learner's own opt-out. Visible by default (0). A hidden learner still
--   earns points and badges, but is left out of every ranking other people
--   see: the board, the monthly board, the recognition cards, the Home
--   podium and the kudos board. Rank is computed over participants only, so
--   nobody can infer a hidden colleague from a gap in the numbering.
--
-- organizations.leaderboard_enabled
--   The tenant switch, the same shape as community_enabled (0049). Off hides
--   the learner leaderboard and the Home podium. Points and badges still
--   accrue, and admins keep their own leaderboard view.
--
-- organizations.leaderboard_name_display
--   How colleagues are named to each other: initial shows first name plus
--   last initial (the community and reviews rule), full shows the full name.
--   The default is initial, which CHANGES what every organization shows
--   today. That was the owner's explicit choice. Admin screens always show
--   full names, because admins already see the full record.
--
-- Additive + idempotent (runs on boot in filename order). No comment here may
-- contain a semicolon, because the migration runner splits on it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_hidden integer NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS leaderboard_enabled integer NOT NULL DEFAULT 1;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS leaderboard_name_display text NOT NULL DEFAULT 'initial';
