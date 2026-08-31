-- Multi-tenancy, wave 1: additive schema only (spec §3.2, §3.3, §3.7, §3.10).
--
-- This is the ONLY tenancy migration allowed to run automatically on boot.
-- Everything non-additive — backfilling real data, `SET NOT NULL`, the
-- composite foreign keys that make the user axis database-enforced, and
-- dropping the single-column indexes these composites supersede — is a
-- deliberate, reviewed script (`scripts/migrate-tenancy.mjs`), never this
-- file. Until that script runs, `organization_id` is nullable everywhere and
-- every existing row has no organization at all; that is expected, not a bug.
--
-- Adding a nullable column with no default is metadata-only on PG 11+, so
-- none of the `ALTER TABLE` statements below rewrite a table.

-- ---------------------------------------------------------------------------
-- The organizations table, and the platform-org sentinel.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id          serial PRIMARY KEY,
  name        text        NOT NULL,
  -- URL-safe; subdomains later.
  slug        text        NOT NULL UNIQUE,
  logo_url    text,
  is_platform boolean     NOT NULL DEFAULT false,
  is_active   integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Exactly one platform organization can ever exist. A partial unique index
-- rather than a boolean singleton table, so the guarantee lives in the same
-- table it describes.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_one_platform
  ON organizations (is_platform) WHERE is_platform;

-- ---------------------------------------------------------------------------
-- organization_id on all 21 tenant-owned tables. Nullable, no default, on
-- purpose: `scripts/migrate-tenancy.mjs` backfills every row into the first
-- real organization and only then adds `NOT NULL` (§3.10, human checkpoint).
--
-- Which org each column carries follows the identity / activity / content
-- rule (§3.3) — recorded here so the next reader does not have to re-derive
-- it, even though the column itself looks identical on every table.
-- ---------------------------------------------------------------------------

-- identity: carries its own org
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id integer;

-- activity: carries the user's org
ALTER TABLE user_course_assignments ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE user_lesson_completions ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE lesson_video_progress ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE user_assessment_attempts ADD COLUMN IF NOT EXISTS organization_id integer;
-- user_assessment_answers has no user_id (0000_baseline_schema.sql:131) — it
-- still carries the learner's org, reached through attempt_id (§3.3 exception).
ALTER TABLE user_assessment_answers ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE user_scorm_assignments ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE scorm_tracking ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE scorm_attempts ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE session_roster ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE session_attendance ADD COLUMN IF NOT EXISTS organization_id integer;

-- content: carries the owner (a real org, or the platform org for global content)
ALTER TABLE courses ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE course_modules ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE lesson_resources ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE assessment_questions ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE assessment_options ADD COLUMN IF NOT EXISTS organization_id integer;
ALTER TABLE scorm_packages ADD COLUMN IF NOT EXISTS organization_id integer;

-- sessions: always a real org, never the platform org (§3.3)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS organization_id integer;

-- ---------------------------------------------------------------------------
-- Composite indexes (§3.7). `organization_id` leads every one of them — it is
-- the most selective predicate available, which is what makes a scoped query
-- faster than today's unscoped equivalent rather than slower (§3.8).
--
-- The single-column predecessors these supersede (idx_users_role_active,
-- idx_completions_lesson, idx_attempts_user_assessment, idx_assignments_course,
-- idx_courses_active, idx_sessions_date, idx_certificates_course) are left in
-- place. Dropping them is non-additive housekeeping for the reviewed script
-- in §3.10, not this file.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_users_org_role_active
  ON users (organization_id, role, is_active);
CREATE INDEX IF NOT EXISTS idx_ulc_org_user
  ON user_lesson_completions (organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_uaa_org_user
  ON user_assessment_attempts (organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_uca_org_user
  ON user_course_assignments (organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_courses_org_active
  ON courses (organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sessions_org_date
  ON sessions (organization_id, date);
CREATE INDEX IF NOT EXISTS idx_certs_org_user
  ON certificates (organization_id, user_id);

-- ---------------------------------------------------------------------------
-- lessons.scorm_package_id
--
-- Pre-existing gap, not introduced by tenancy: `hasAccess`,
-- `findAccessiblePackage` and now the SCORM content middleware all join
-- lessons on this column, and the middleware's join runs on every package
-- launch. §7.4 requires an index on every joined column.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lessons_scorm_package
  ON lessons (scorm_package_id);
