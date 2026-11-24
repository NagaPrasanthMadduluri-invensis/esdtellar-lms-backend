-- 0074_session_batch_schedule.sql
--
-- Batch scheduling (owner request 2026-11-24).
--
-- 1. A batch, and a session with no batches, may span several days. end_date
--    is the last day, inclusive. NULL means a single day (end = start), which
--    is every row written before this migration, so nothing changes for them.
--    Times stay per day: the sitting runs start_time to end_time on each date.
--
-- 2. Each batch keeps its own queue. session_waitlist.batch_id names the batch
--    a learner is waiting for. NULL is a queue for the session as a whole (a
--    session with no batches). Deleting a batch drops its queue onto the
--    session queue rather than losing anybody's place.
--
-- Additive and idempotent.

ALTER TABLE session_batches ADD COLUMN IF NOT EXISTS end_date text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS end_date text;

ALTER TABLE session_waitlist
  ADD COLUMN IF NOT EXISTS batch_id integer
  REFERENCES session_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_session_waitlist_batch
  ON session_waitlist (batch_id)
  WHERE batch_id IS NOT NULL;

