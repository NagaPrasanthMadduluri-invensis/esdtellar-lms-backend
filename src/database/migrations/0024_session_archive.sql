-- Live Sessions: archive, matching Course Library and Learning Paths.
--
-- Additive and idempotent (§6.2). One nullable column and one index.
--
-- ARCHIVE IS ORTHOGONAL TO `status`, which is why it is its own column.
-- `sessions.status` records what a human decided — upcoming, cancelled,
-- completed — and `display_status` derives "in progress" from the clock
-- (§10.7). Folding archive into that enum would give the admin form a fifth
-- value to round-trip and would lose which of the four the session was in.
--
-- WHAT ARCHIVING A SESSION DOES NOT DO, and this matters more here than it did
-- for courses: it does NOT touch the companion training course, the roster,
-- the attendance record or anybody's completion. A session IS a course
-- assignment (§10.7), so deleting one cascades through
-- `user_course_assignments` and `user_lesson_completions` and takes real
-- learning history with it. Archiving is the safe way to clear a finished
-- session off the working list, and the card's Delete confirm says so.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- The list is always one org's sessions, filtered to archived or not, newest
-- scheduled first.
CREATE INDEX IF NOT EXISTS idx_sessions_org_archived
  ON sessions (organization_id, archived_at, date DESC);
