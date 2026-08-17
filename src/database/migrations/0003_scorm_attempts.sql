-- Per-attempt SCORM history.
--
-- `scorm_tracking` holds ONE row per (user, package) and is upserted on every
-- commit, so it can only ever describe the learner's current state — it is the
-- resume/bookmark record the player needs, and it must keep working that way.
-- This table is the opposite: append-only, one row per completed attempt,
-- mirroring `user_assessment_attempts` so the admin views can read the same
-- shape for a SCORM package as for an assessment.
--
-- A row is written when the content reports it is finished (LMSFinish /
-- Terminate, or the status becoming passed/failed/completed) and the previous
-- state was not already terminal. `cmi_data` snapshots the whole CMI object at
-- that moment, which is what makes a per-question breakdown possible after the
-- fact — `cmi.interactions` is inside it when the package reports questions.
--
-- Additive and idempotent (BACKEND_STRUCTURE.md §6.2).

CREATE TABLE IF NOT EXISTS scorm_attempts (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id        INTEGER     NOT NULL REFERENCES scorm_packages(id) ON DELETE CASCADE,
  attempt_number    INTEGER     NOT NULL,
  score_raw         REAL,
  score_max         REAL,
  -- Rounded 0-100, NULL when the package reports no score at all.
  percentage        INTEGER,
  lesson_status     TEXT,
  completion_status TEXT,
  success_status    TEXT,
  -- 1 / 0, or NULL when the package only reports completion and never grades.
  is_passed         INTEGER,
  total_time        TEXT,
  cmi_data          TEXT        NOT NULL DEFAULT '{}',
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The admin views read every attempt for one learner on one package, newest
-- first; the package-wide roll-up reads by package alone.
CREATE INDEX IF NOT EXISTS idx_scorm_attempts_user_package
  ON scorm_attempts (user_id, package_id);
CREATE INDEX IF NOT EXISTS idx_scorm_attempts_package
  ON scorm_attempts (package_id);
