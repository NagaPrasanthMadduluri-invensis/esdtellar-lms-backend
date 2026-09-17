-- Learning Paths: archive, matching what Course Library already has.
--
-- Additive and idempotent (§6.2). One nullable column and one index.
--
-- ARCHIVE IS A THIRD STATE, ORTHOGONAL TO ACTIVE/DRAFT — which is why it is
-- `archived_at` and not a third value of `is_active`. Exactly the argument
-- 0019 made for courses, and for the same reason: an archived path remembers
-- whether it was active, so restoring returns it to what it was rather than to
-- a guess.
--
-- Archiving does NOT withdraw anybody's enrolment. It takes the path out of
-- the builder's default view and out of the assign picker; a learner halfway
-- through keeps their progress and their place. Deleting an in-progress path
-- because an admin was tidying up has no undo, and the journey gate (§10.11)
-- reads `journey_enrollments`, not this column.

ALTER TABLE journeys
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- The list is always one org's paths, filtered to archived or not, newest
-- first. Serves both halves of that filter as an index-ordered scan.
CREATE INDEX IF NOT EXISTS idx_journeys_org_archived
  ON journeys (organization_id, archived_at, created_at DESC);
