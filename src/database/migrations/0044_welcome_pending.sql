-- 0044_welcome_pending.sql — the durable marker that no bulk-created learner's
-- welcome email can slip through.
--
-- THE GAP THIS CLOSES
--
-- A bulk import creates learners (committed, per row) and THEN enqueues their
-- welcome emails in a batch after the loop. That enqueue is best-effort
-- (§8.4): if the process restarts in the window, or a chunk's write fails,
-- the learner exists with no welcome row and nothing retries it — and the
-- admin's Resend button only recovers a FAILED row, not a MISSING one. The
-- outbox pattern (§10.30) only gives its guarantee when the outbox row is
-- written in the SAME transaction as the business row; the bulk path cannot
-- do that, because it enqueues in one batch after N separate user inserts.
--
-- THE FIX: A FLAG WRITTEN WITH THE USER
--
-- `welcome_pending_since` is set in the SAME INSERT that creates the learner,
-- when a welcome was requested — so if the learner row exists, the intent is
-- recorded, atomically, with no window. It is cleared the moment a welcome
-- outbox row exists for them. A worker sweep (§10.33) re-enqueues anything
-- still set after a grace window. The flag, not a token or a guessed
-- heuristic, is what distinguishes "owed a welcome" from "the admin opted
-- out" (which never sets it) and from "already sent" (which clears it).
--
-- NULL is the default and the overwhelming majority: every existing user, and
-- every learner whose welcome was opted out or already sent. So the index is
-- PARTIAL over the non-null few, the same instinct as idx_notifications_unread
-- — the sweep's query is the only reader and it only ever wants those.

ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_pending_since timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_welcome_pending
  ON users (welcome_pending_since)
  WHERE welcome_pending_since IS NOT NULL;
