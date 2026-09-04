-- Cloud-native SCORM storage, plus a granular runtime data-model log.
--
-- Two additive, idempotent changes (BACKEND_STRUCTURE.md §6.2).
--
-- 1. scorm_packages.storage_prefix
--
--    Records WHERE a package's files live, rather than recomputing it. NULL
--    means "extracted to local disk under <SCORM_STORAGE_PATH>/<package_dir>",
--    which is every row that already exists -- so this column being nullable
--    is what lets the local and s3 drivers coexist and makes the move
--    per-package instead of a flag day.
--
--    It is stored rather than derived from organization_id because the owner
--    and the reader are not always the same tenant: a package owned by the
--    platform organization is readable by every org (multi-tenancy.md §3.4),
--    so deriving the prefix from the REQUESTING org would address the wrong
--    keys for exactly those global packages.
--
-- 2. scorm_datamodel_log
--
--    Append-only, one row per SetValue delta the runtime reports. This is the
--    third and finest of three deliberately different grains, and none of them
--    replaces another:
--
--      scorm_tracking      one row per (user, package), upserted -- the resume
--                          record the player reloads. Current state only.
--      scorm_attempts      one row per finished attempt, with a CMI snapshot.
--                          Per-attempt history.
--      scorm_datamodel_log every individual element write, timestamped. What
--                          the learner did, in order, within an attempt.
--
--    Named datamodel_log rather than scorm_interactions on purpose:
--    `cmi.interactions.*` is a specific SCORM sub-tree, already parsed out of
--    scorm_attempts.cmi_data by modules/scorm/interactions.util.ts. This table
--    holds EVERY element -- lesson_location, total_time, suspend_data and the
--    interactions alike -- so naming it after one sub-tree would misdescribe it
--    and collide with the existing helper.

ALTER TABLE scorm_packages ADD COLUMN IF NOT EXISTS storage_prefix text;

CREATE TABLE IF NOT EXISTS scorm_datamodel_log (
  -- BIGSERIAL, not SERIAL: this is the highest-volume table in the system by
  -- design. One learner working through one package emits hundreds of SetValue
  -- calls, and a 32-bit key would be a real ceiling rather than a theoretical
  -- one. UUID was considered and rejected -- every other primary key here is
  -- an integer, and a random UUID primary key on an append-only, time-ordered
  -- table scatters inserts across the btree instead of appending to its right
  -- edge.
  id              BIGSERIAL   PRIMARY KEY,

  -- Mandatory tenant separation. NOT NULL from the start, unlike the columns
  -- 0007 added to pre-existing tables, because this table has no historical
  -- rows to backfill -- so the constraint can be right immediately.
  organization_id INTEGER     NOT NULL REFERENCES organizations(id),

  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The package, not the course. scorm_packages.course_id is nullable: a
  -- package can live in the library before it is attached to any course, and
  -- be reused by several, so a course_id here would be NULL for most rows and
  -- would need rewriting whenever an attachment changed. Join through
  -- scorm_packages when a report needs the course.
  package_id      INTEGER     NOT NULL REFERENCES scorm_packages(id) ON DELETE CASCADE,

  -- Which sitting this delta belongs to, matching scorm_attempts.attempt_number.
  -- Without it a re-take's writes interleave with the previous attempt's in
  -- every time-ordered read, and "what did they answer" stops having one answer.
  attempt_number  INTEGER     NOT NULL DEFAULT 1,

  -- e.g. cmi.core.lesson_location, cmi.interactions.0.learner_response,
  -- cmi.core.total_time. VARCHAR(255) rather than TEXT purely as a sanity
  -- bound: a legal SCORM element path is far shorter, so anything longer is a
  -- malformed or hostile key and should be rejected at the boundary, not stored.
  element_key     VARCHAR(255) NOT NULL,

  -- Nullable: SetValue('', ...) and cleared elements are legitimate, and a
  -- sentinel empty string would be indistinguishable from a real one.
  element_value   TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- organization_id leads, matching every composite index 0007/0008 added: it is
-- the predicate present on every single query against this table (§3.7).
CREATE INDEX IF NOT EXISTS idx_scorm_datamodel_log_org_user
  ON scorm_datamodel_log (organization_id, user_id);

-- The learner-timeline read: one learner on one package, newest first.
CREATE INDEX IF NOT EXISTS idx_scorm_datamodel_log_user_package_time
  ON scorm_datamodel_log (organization_id, user_id, package_id, created_at DESC);

-- The analytics read: one element across a package's learners, e.g. every
-- learner_response to interaction 3.
CREATE INDEX IF NOT EXISTS idx_scorm_datamodel_log_package_element
  ON scorm_datamodel_log (organization_id, package_id, element_key);
