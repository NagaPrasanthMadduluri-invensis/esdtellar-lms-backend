-- 0068 - System heartbeats, for the Cliq alerts (BACKEND_STRUCTURE 10.50).
--
-- The worker writes a row here every minute. The API reads it every minute,
-- and alerts the team when the worker has gone quiet, because a stopped worker
-- is silent by nature: emails stop, reminders stop, nightly jobs stop, and
-- nothing on any screen says so. One row per process name. No personal data.

CREATE TABLE IF NOT EXISTS system_heartbeats (
  name    text PRIMARY KEY,
  beat_at timestamptz NOT NULL DEFAULT now()
);
