-- Measured watch time for uploaded video, plus the video's real duration.
--
-- Until now a video lesson credited `lessons.duration_minutes` in full the
-- moment it was marked complete: a number an admin typed, awarded whether the
-- learner watched the whole thing or ten seconds of it. SCORM meanwhile
-- reported real time, so the two content types were never comparable.
--
-- `watched_seconds` is the FURTHEST position the learner reached, not a sum of
-- playing time. That choice matters. The player already blocks seeking past the
-- furthest point, so this cannot be inflated by skipping, and rewatching a
-- section does not count twice. It is "how much of this video was actually
-- consumed", which is the honest input to a learning-hours figure.
--
-- Additive and idempotent (BACKEND_STRUCTURE.md 6.2).

CREATE TABLE IF NOT EXISTS lesson_video_progress (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id             INTEGER     NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  -- Monotonic: only ever raised, never lowered, so a replay cannot reduce it.
  watched_seconds       INTEGER     NOT NULL DEFAULT 0,
  -- Where to resume from. Free to move backwards, unlike watched_seconds.
  last_position_seconds INTEGER     NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, lesson_id)
);

-- The hours query reads every learner's progress at once, and the player reads
-- one row by (user, lesson) which the UNIQUE constraint already indexes.
CREATE INDEX IF NOT EXISTS idx_video_progress_lesson
  ON lesson_video_progress (lesson_id);

-- Real duration of the uploaded file, read from the video's own metadata at
-- upload time. `duration_minutes` stays as the admin-declared figure and is now
-- only a fallback, so the two never fight.
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS video_duration_seconds INTEGER;
