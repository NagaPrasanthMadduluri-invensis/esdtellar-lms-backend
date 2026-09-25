-- Session feedback: what a learner thought of a sitting they attended.
--
-- Additive and idempotent (§6.2). One table.
--
-- =========================================================================
-- THE TRAINER NEVER LEARNS WHO SAID WHAT
-- =========================================================================
--
-- `user_id` IS stored, and the trainer's endpoints never select it. That
-- combination is the whole design, and both halves are load-bearing:
--
--   * stored, because UNIQUE (session_id, user_id) is what stops one learner
--     rating a session five times, and because an admin investigating an
--     abusive comment has to be able to attribute it. Anonymity to the
--     trainer is a promise about who READS the column, not about whether it
--     exists.
--   * never selected by a trainer route, because a learner who knows their
--     trainer sees their name writes something politer than what they think.
--     The signal is the point; a named channel produces courtesy.
--
-- This asymmetry only survives if it is enforced in ONE place. Every trainer
-- read goes through `FeedbackRepository.listForTrainer` /
-- `.summaryForTrainer`, which name their columns explicitly and do not
-- include `user_id`. A `SELECT *` added here later would silently break the
-- promise, which is why §3.1's explicit-column-list rule matters more in this
-- table than anywhere else in the schema.
--
-- =========================================================================
-- ONLY SOMEBODY WHO ATTENDED MAY RATE IT
-- =========================================================================
--
-- Eligibility reuses the definition §10.7 already fixed: `present`, `late`
-- and `partial` are the three attendance statuses that credit a learner for
-- the training. Those same three may leave feedback. `absent` and `excused`
-- may not, because a rating from somebody who was not in the room measures
-- nothing about the session.
--
-- That is checked in the service against `session_attendance`, not by a
-- constraint here: attendance can be corrected afterwards (syncCompletions
-- moves credit in both directions), and a CHECK would turn an admin fixing a
-- mis-marked absence into a foreign-key error.
--
-- =========================================================================
-- THREE RATINGS, NOT ONE
-- =========================================================================
--
-- Content, trainer and delivery are separate columns because they fail
-- separately and they have different owners: thin material is the admin's to
-- fix, an unclear explanation is the trainer's, a broken joining link is
-- neither. One averaged number would tell a trainer their session scored 3.1
-- and nothing about which of the three to change.
--
-- All three are NOT NULL: a partially answered form is a row that skews every
-- average it appears in, and the UI requires all three before Save.

CREATE TABLE IF NOT EXISTS session_feedback (
  id              serial PRIMARY KEY,

  -- ACTIVITY, so `orgScope` and never `contentScope` (§10.12). A session is
  -- org-owned, and so is an opinion about it.
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  session_id      integer NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,

  -- The author. Read by admin routes, never by trainer routes — see header.
  -- CASCADE: deleting a person removes what they wrote, which is the right
  -- default for an opinion attached to a name.
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- 1..5 each, the three dimensions from `common/feedback.ts`. The CHECK is
  -- here as well as in the DTO because a rating outside the scale silently
  -- poisons every average computed over it, and averages are the only thing
  -- this table is for.
  rating_content  integer NOT NULL CHECK (rating_content  BETWEEN 1 AND 5),
  rating_trainer  integer NOT NULL CHECK (rating_trainer  BETWEEN 1 AND 5),
  rating_delivery integer NOT NULL CHECK (rating_delivery BETWEEN 1 AND 5),

  -- Optional free text, capped at DESCRIPTION_MAX_LENGTH by the DTO (§8.5).
  -- `text`, not varchar, for the reason content-limits.ts gives: the cap is a
  -- product rule that may move and should not need a migration.
  comment         text,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One person, one opinion per session. This is why `user_id` is stored.
  UNIQUE (session_id, user_id)
);

-- The trainer's per-session read and every average over it.
CREATE INDEX IF NOT EXISTS idx_session_feedback_session
  ON session_feedback (session_id);

-- "Have I already rated this?" on the learner's side, and the admin's
-- per-person view. Not covered by the UNIQUE above, whose leftmost column is
-- session_id (§6.3).
CREATE INDEX IF NOT EXISTS idx_session_feedback_user
  ON session_feedback (user_id);

-- Every trainer read is org-scoped first, then narrowed to their sessions.
CREATE INDEX IF NOT EXISTS idx_session_feedback_org_created
  ON session_feedback (organization_id, created_at DESC);
