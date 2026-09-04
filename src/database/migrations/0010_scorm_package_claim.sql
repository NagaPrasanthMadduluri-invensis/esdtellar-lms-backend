-- Stop the lesson editor leaving orphaned SCORM packages behind.
--
-- THE PROBLEM. The lesson editor has to upload the zip BEFORE it can save the
-- lesson: it needs the package id for the payload, and the manifest's declared
-- duration to prefill the duration field. So the package row and its extracted
-- files are committed first, and if the lesson save then fails or is abandoned,
-- the package survives with nothing pointing at it. Ten uploads on 2026-09-04
-- left eight such rows, all visible in the admin SCORM library, which is what
-- made a failed save look like a successful one.
--
-- THE FIX. A package is "claimed" once something actually uses it:
--
--   claimed_at NOT NULL  a real package  -- uploaded to the library directly,
--                        or attached to a lesson that saved successfully.
--   claimed_at NULL      provisional     -- uploaded by the lesson editor, no
--                        lesson has referenced it yet. Hidden from the library
--                        list, and swept once it is old enough to be certain
--                        the editor that created it is gone.
--
-- Library uploads are claimed at creation, so this is invisible to that flow
-- and to any existing caller: the column defaults to now() and only the lesson
-- editor's explicit `provisional` flag leaves it NULL.
--
-- Existing rows are backfilled to now() rather than NULL. They predate the
-- flag, so nothing can say which were provisional, and defaulting them to
-- claimed means the sweep can never delete a package someone is relying on.
-- Genuinely orphaned pre-existing rows are the job of
-- `npm run db:clean-orphan-scorm`, which decides by reference rather than by
-- this column.
--
-- Additive and idempotent (BACKEND_STRUCTURE.md §6.2).

ALTER TABLE scorm_packages
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

UPDATE scorm_packages SET claimed_at = created_at WHERE claimed_at IS NULL;

ALTER TABLE scorm_packages
  ALTER COLUMN claimed_at SET DEFAULT now();

-- The sweep reads only unclaimed rows, and there are almost never any, so a
-- partial index keeps it off the main table entirely. organization_id does not
-- lead here -- unlike every index in 0007/0008 -- because the sweep is
-- deliberately cross-org: it is housekeeping run by the server itself, not a
-- tenant-scoped read.
CREATE INDEX IF NOT EXISTS idx_scorm_packages_unclaimed
  ON scorm_packages (created_at)
  WHERE claimed_at IS NULL;
