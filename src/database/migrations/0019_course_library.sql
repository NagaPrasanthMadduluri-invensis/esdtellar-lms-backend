-- The Course Library: category, importance, renewal cadence, tags, archive.
--
-- All additive and idempotent (§6.2) — ADD COLUMN IF NOT EXISTS and
-- CREATE INDEX IF NOT EXISTS throughout, safe on every boot. No existing row
-- changes meaning: every new column is nullable or defaults to the value the
-- current behaviour already implies.
--
-- WHAT THIS ADDS AND WHY EACH ONE IS A COLUMN.
--
--   category        The library filters, groups and colours by it, and the
--                   value `Compliance` carries behaviour (see is_mandatory).
--                   Closed list in src/common/course-taxonomy.ts, enforced by
--                   the DTO — the same split as location/job_level (§10.12).
--
--   is_mandatory    "Everyone must do this", shown as the card ribbon. A
--                   SEPARATE flag from category because a mandatory course is
--                   not always a compliance one: an onboarding course can be
--                   required without being regulatory. The reverse does not
--                   hold — compliance implies mandatory — and that implication
--                   lives in `isMandatory()`, not in this column, so an admin
--                   filing something under Compliance cannot forget to tick it.
--
--   expiry_months   How often the training must be retaken. Only meaningful
--                   for compliance, which is why it is nullable rather than
--                   defaulted: NULL means "does not expire", and that is the
--                   honest state for the other six categories.
--
--                   NOTE what this does NOT do. It records the cadence and the
--                   card prints "Renews every 12 mo". Nothing expires a
--                   completion yet — that needs a scheduled re-assignment, and
--                   there is no scheduler here (§10.9 makes the same point
--                   about the SCORM sweep). Do not read this column as though
--                   completions were being aged out.
--
--   tags            Free text, and deliberately so: the search box reads
--                   "title, category, tags" and tags are what an admin uses to
--                   find things the closed category cannot express. Nothing
--                   filters or branches on a tag, so nothing breaks on a typo
--                   — which is exactly the test for whether a value may be
--                   free text (contrast `job_role`, §10.12).
--
--   archived_at     Archive is a THIRD state, orthogonal to published/draft.
--                   Keeping it on its own nullable timestamp rather than a
--                   third value of `is_active` is what lets an archived course
--                   remember whether it was published when it was archived,
--                   and be restored to that state rather than to a guess.
--
-- ARCHIVING DOES NOT WITHDRAW A LEARNER'S ASSIGNMENT, and that is deliberate.
-- It removes the course from the admin library's default view and stops it
-- being assigned again; somebody already halfway through keeps their progress.
-- Deleting an in-progress training because an admin was tidying up is the kind
-- of destruction there is no undo for.

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS category      text,
  ADD COLUMN IF NOT EXISTS is_mandatory  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expiry_months integer,
  ADD COLUMN IF NOT EXISTS tags          text,
  ADD COLUMN IF NOT EXISTS archived_at   timestamptz;

-- The library's default read is "this org's courses that are not archived",
-- grouped and filtered by category. organization_id leads for the same reason
-- it leads every other index here (spec §3.7).
CREATE INDEX IF NOT EXISTS idx_courses_org_archived
  ON courses (organization_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_courses_org_category
  ON courses (organization_id, category);
