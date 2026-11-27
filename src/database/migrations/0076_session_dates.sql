-- 0076_session_dates.sql
--
-- Session dates and day batches (owner request 2026-11-27, BACKEND_STRUCTURE 10.67).
--
-- A session is now: Session -> Session dates (any set of days, not a range)
-- -> Day batches (several per date, each with its own times and capacity).
-- A learner attends EVERY date and is placed in one batch on each date
-- (session_batch_members). Attendance is marked per date
-- (session_day_attendance) and rolled up into session_attendance, which
-- everything downstream (crediting, certificates, feedback, reports) already
-- reads, so none of those needed to change.
--
-- session_batches is reused as the day-batch table: each row now belongs to
-- one session_dates row and runs on that one day (end_date stays NULL).
--
-- Moving a date keeps its row, so its batches, placements and attendance move
-- with it. original_date, previous_date and change ('postponed' or
-- 'preponed') record what happened so every portal can say so.
--
-- The tables are additive and idempotent. The backfill that converts existing
-- sessions (ranges into dates, multi-day batches into one batch per day,
-- roster placements into per-date placements, attendance onto each date) runs
-- ONCE, guarded by a row in migration_backfills, because this runner re-runs
-- every file on every boot and a re-run would undo admins' later edits.

CREATE TABLE IF NOT EXISTS migration_backfills (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_dates (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL,
  session_id integer NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  date text NOT NULL,
  original_date text NOT NULL,
  previous_date text,
  change text CHECK (change IN ('postponed', 'preponed')),
  changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_dates_session_date_unique UNIQUE (session_id, date)
);

CREATE INDEX IF NOT EXISTS idx_session_dates_org
  ON session_dates (organization_id, session_id);

ALTER TABLE session_batches
  ADD COLUMN IF NOT EXISTS session_date_id integer
  REFERENCES session_dates (id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS session_batch_members (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL,
  session_id integer NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  session_date_id integer NOT NULL REFERENCES session_dates (id) ON DELETE CASCADE,
  batch_id integer NOT NULL REFERENCES session_batches (id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_batch_members_date_user_unique UNIQUE (session_date_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_batch_members_batch
  ON session_batch_members (batch_id);
CREATE INDEX IF NOT EXISTS idx_session_batch_members_session_user
  ON session_batch_members (session_id, user_id);
CREATE INDEX IF NOT EXISTS idx_session_batch_members_org
  ON session_batch_members (organization_id, session_id);

CREATE TABLE IF NOT EXISTS session_day_attendance (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL,
  session_id integer NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  session_date_id integer NOT NULL REFERENCES session_dates (id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status text CHECK (status IN ('present', 'absent', 'late', 'partial', 'excused')),
  join_time text,
  notes text,
  marked_by integer REFERENCES users (id) ON DELETE SET NULL,
  is_locked integer NOT NULL DEFAULT 0,
  marked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_day_attendance_date_user_unique UNIQUE (session_date_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_session_day_attendance_session_user
  ON session_day_attendance (session_id, user_id);
CREATE INDEX IF NOT EXISTS idx_session_day_attendance_org
  ON session_day_attendance (organization_id, session_id);

-- Batch numbers are now per date, so the per-session unique goes.
DROP INDEX IF EXISTS idx_session_batches_session_no;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM migration_backfills WHERE name = '0076_session_dates') THEN
    RETURN;
  END IF;

  -- 1. Dates. A session with dated batches runs on the union of its batches'
  --    days. Otherwise it runs on its own start-to-end range.
  INSERT INTO session_dates (organization_id, session_id, date, original_date)
  SELECT DISTINCT b.organization_id, b.session_id, to_char(g, 'YYYY-MM-DD'), to_char(g, 'YYYY-MM-DD')
    FROM session_batches b
    CROSS JOIN LATERAL generate_series(
      b.date::date,
      GREATEST(b.date::date, COALESCE(NULLIF(b.end_date, ''), b.date)::date),
      interval '1 day') g
   WHERE b.date ~ '^\d{4}-\d{2}-\d{2}$'
     AND (b.end_date IS NULL OR b.end_date = '' OR b.end_date ~ '^\d{4}-\d{2}-\d{2}$')
  ON CONFLICT (session_id, date) DO NOTHING;

  INSERT INTO session_dates (organization_id, session_id, date, original_date)
  SELECT s.organization_id, s.id, to_char(g, 'YYYY-MM-DD'), to_char(g, 'YYYY-MM-DD')
    FROM sessions s
    CROSS JOIN LATERAL generate_series(
      s.date::date,
      GREATEST(s.date::date, COALESCE(NULLIF(s.end_date, ''), s.date)::date),
      interval '1 day') g
   WHERE s.date ~ '^\d{4}-\d{2}-\d{2}$'
     AND (s.end_date IS NULL OR s.end_date = '' OR s.end_date ~ '^\d{4}-\d{2}-\d{2}$')
     AND NOT EXISTS (SELECT 1 FROM session_dates sd WHERE sd.session_id = s.id)
  ON CONFLICT (session_id, date) DO NOTHING;

  -- 2. Each dated batch belongs to its first day.
  UPDATE session_batches b
     SET session_date_id = sd.id
    FROM session_dates sd
   WHERE b.session_date_id IS NULL
     AND sd.session_id = b.session_id
     AND sd.date = b.date;

  -- 3. A batch that spanned days becomes one batch per day, same number,
  --    label, times, capacity, trainer and status.
  INSERT INTO session_batches
    (organization_id, session_id, batch_no, label, date, end_date, start_time,
     end_time, capacity, trainer_user_id, status, session_date_id)
  SELECT b.organization_id, b.session_id, b.batch_no, b.label, sd.date, NULL,
         b.start_time, b.end_time, b.capacity, b.trainer_user_id, b.status, sd.id
    FROM session_batches b
    CROSS JOIN LATERAL generate_series(
      b.date::date + 1, b.end_date::date, interval '1 day') g
    JOIN session_dates sd
      ON sd.session_id = b.session_id AND sd.date = to_char(g, 'YYYY-MM-DD')
   WHERE b.session_date_id IS NOT NULL
     AND b.end_date ~ '^\d{4}-\d{2}-\d{2}$'
     AND b.end_date > b.date
     AND NOT EXISTS (
       SELECT 1 FROM session_batches x
        WHERE x.session_date_id = sd.id AND x.batch_no = b.batch_no);

  -- 4. A batch with no date yet goes on the session's first date.
  UPDATE session_batches b
     SET session_date_id = first.id, date = first.date
    FROM (
      SELECT DISTINCT ON (session_id) id, session_id, date
        FROM session_dates ORDER BY session_id, date
    ) first
   WHERE b.session_date_id IS NULL
     AND b.date IS NULL
     AND first.session_id = b.session_id;

  -- 5. Someone placed in a batch is placed in that batch on each of its days.
  INSERT INTO session_batch_members (organization_id, session_id, session_date_id, batch_id, user_id)
  SELECT sr.organization_id, sr.session_id, b2.session_date_id, b2.id, sr.user_id
    FROM session_roster sr
    JOIN session_batches b ON b.id = sr.batch_id
    JOIN session_batches b2
      ON b2.session_id = b.session_id AND b2.batch_no = b.batch_no
     AND b2.session_date_id IS NOT NULL
  ON CONFLICT (session_date_id, user_id) DO NOTHING;

  UPDATE session_batches SET end_date = NULL
   WHERE end_date IS NOT NULL AND session_date_id IS NOT NULL;

  -- 6. A date with no batch gets Batch 1, which follows the session's own
  --    times and capacity (NULLs fall back to the session's).
  INSERT INTO session_batches
    (organization_id, session_id, batch_no, label, date, end_date, start_time,
     end_time, capacity, trainer_user_id, status, session_date_id)
  SELECT sd.organization_id, sd.session_id, 1, NULL, sd.date, NULL, NULL, NULL,
         NULL, NULL, 'scheduled', sd.id
    FROM session_dates sd
   WHERE NOT EXISTS (SELECT 1 FROM session_batches b WHERE b.session_date_id = sd.id);

  -- 7. Everyone on the roster is placed on each date that has only one batch.
  INSERT INTO session_batch_members (organization_id, session_id, session_date_id, batch_id, user_id)
  SELECT sr.organization_id, sr.session_id, b.session_date_id, b.id, sr.user_id
    FROM session_roster sr
    JOIN session_batches b ON b.session_id = sr.session_id AND b.session_date_id IS NOT NULL
   WHERE (SELECT COUNT(*) FROM session_batches b3 WHERE b3.session_date_id = b.session_date_id) = 1
  ON CONFLICT (session_date_id, user_id) DO NOTHING;

  -- 8. Attendance already marked applies to every date, which rolls back up
  --    to the same overall status.
  INSERT INTO session_day_attendance
    (organization_id, session_id, session_date_id, user_id, status, join_time,
     notes, marked_by, is_locked, marked_at)
  SELECT sa.organization_id, sa.session_id, sd.id, sa.user_id, sa.status,
         sa.join_time, sa.notes, sa.marked_by, sa.is_locked, sa.marked_at
    FROM session_attendance sa
    JOIN session_dates sd ON sd.session_id = sa.session_id
  ON CONFLICT (session_date_id, user_id) DO NOTHING;

  -- 9. The session row keeps a summary: first date and last date.
  UPDATE sessions s
     SET date = r.first_date,
         end_date = CASE WHEN r.last_date = r.first_date THEN NULL ELSE r.last_date END
    FROM (
      SELECT session_id, MIN(date) AS first_date, MAX(date) AS last_date
        FROM session_dates GROUP BY session_id
    ) r
   WHERE r.session_id = s.id;

  INSERT INTO migration_backfills (name) VALUES ('0076_session_dates');
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_batches_date_no
  ON session_batches (session_date_id, batch_no);
