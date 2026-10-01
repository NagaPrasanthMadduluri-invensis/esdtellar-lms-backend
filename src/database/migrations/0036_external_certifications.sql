-- External certifications: training done elsewhere, counted here once two
-- people have said it really happened.
--
-- Additive and idempotent (§6.2). One table, one nullable column on
-- `courses`, and nothing is backfilled — no existing row changes meaning.
--
-- =========================================================================
-- AN APPROVED CERTIFICATION GETS A COMPANION COURSE (§10.7's PATTERN AGAIN)
-- =========================================================================
--
-- The requirement is that an approved certification appears in My Courses
-- marked "completed externally", counts as a completed course, and adds its
-- hours to the learner's total.
--
-- Doing that from a standalone table would mean teaching four things about a
-- new concept: `LearningHoursService` (whose whole point is that exactly ONE
-- place knows what an hour is, §10.4), the completion counts, My Courses,
-- and the analytics mode-of-learning split. It would also break a stated
-- invariant — §10.4 promises the per-COURSE minutes sum to the per-LEARNER
-- total, and hours belonging to no course cannot.
--
-- So an approval writes the same shape a session does: one course carrying
-- one module and one lesson, plus the learner's assignment and completion.
-- Every definition that already works then picks it up with no new code
-- path, and the per-course sum still holds because the hours DO belong to a
-- course.
--
-- `courses.external_certification_id` is the marker, mirroring
-- `courses.session_id`. Everywhere that already excludes a session training
-- from a library, a picker or a catalogue excludes these for the same
-- reason: it is not a library entry, it is one person's record.
--
-- =========================================================================
-- HOURS ARE STORED IN MINUTES, THOUGH THE FORM ASKS FOR HOURS
-- =========================================================================
--
-- Every duration in this database is `duration_minutes`. A second unit on
-- one table is how a number gets multiplied by sixty twice, and the
-- companion lesson this becomes needs minutes anyway. The learner types
-- hours because that is how a certificate is written; the DTO converts once,
-- at the boundary.
--
-- =========================================================================
-- THE FILE
-- =========================================================================
--
-- `file_path` is a path RELATIVE to `UPLOAD_STORAGE_PATH`, never a URL.
-- Unlike a course thumbnail — which is served anonymously by
-- `useStaticAssets` because `next/image` fetches it with no cookie — a
-- certificate is somebody's personal document and is streamed by an
-- authenticated route that checks the caller is its owner, that owner's
-- manager, or an admin of their organization.

CREATE TABLE IF NOT EXISTS external_certifications (
  id              serial PRIMARY KEY,

  -- ACTIVITY: always the learner's own org, never widened (§10.12).
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- The claim. All five are required by the DTO; `name_on_certificate` is
  -- separate from the user's own name on purpose — a certificate often
  -- carries a maiden name, an initial or a transliteration, and an approver
  -- comparing the document to the record needs to see what it actually says.
  name_on_certificate text    NOT NULL,
  course_name         text    NOT NULL,
  course_minutes      integer NOT NULL,
  authorized_body     text    NOT NULL,

  file_path       text    NOT NULL,
  file_name       text    NOT NULL,
  file_mime       text    NOT NULL,
  file_size_bytes integer NOT NULL,

  -- One of EXTERNAL_CERT_STATUSES. Text with no CHECK, like every other
  -- status column here: the vocabulary is code (`common/external-
  -- certifications.ts`) so adding a state does not need a migration.
  status          text    NOT NULL DEFAULT 'pending_manager',

  -- Who it was sent to, captured AT SUBMISSION. The learner's manager may
  -- change afterwards, and the trail has to say who was actually asked
  -- rather than who happens to be their manager when somebody reads it.
  -- NULL means there was no manager and it went straight to L&D.
  manager_user_id    integer REFERENCES users (id) ON DELETE SET NULL,
  manager_decided_by integer REFERENCES users (id) ON DELETE SET NULL,
  manager_decided_at timestamptz,
  manager_note       text,

  admin_decided_by   integer REFERENCES users (id) ON DELETE SET NULL,
  admin_decided_at   timestamptz,
  admin_note         text,

  -- The companion course an approval created, so a later revoke could find
  -- it. Nullable: nothing exists until the final approval.
  course_id       integer REFERENCES courses (id) ON DELETE SET NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The learner's own list, newest first.
CREATE INDEX IF NOT EXISTS idx_external_certs_user
  ON external_certifications (user_id, created_at DESC);

-- The two queues: "what is waiting on me". Partial, because a decided row is
-- never in a queue and the pending set is a small minority over time.
CREATE INDEX IF NOT EXISTS idx_external_certs_manager_queue
  ON external_certifications (manager_user_id)
  WHERE status = 'pending_manager';

CREATE INDEX IF NOT EXISTS idx_external_certs_admin_queue
  ON external_certifications (organization_id)
  WHERE status = 'pending_admin';

CREATE INDEX IF NOT EXISTS idx_external_certs_org_status
  ON external_certifications (organization_id, status, created_at DESC);

-- ── The companion-course marker ──
-- Mirrors `courses.session_id`: a course carrying this is one person's
-- external record, not a library entry. ON DELETE SET NULL rather than
-- cascade — deleting the claim must not delete a course somebody's learning
-- history now points at; the service unwinds that deliberately.
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS external_certification_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'courses_external_certification_fk'
  ) THEN
    ALTER TABLE courses
      ADD CONSTRAINT courses_external_certification_fk
      FOREIGN KEY (external_certification_id)
      REFERENCES external_certifications (id) ON DELETE SET NULL;
  END IF;
END $$;

-- One companion course per certification, and the lookup every exclusion
-- makes ("is this course an external record?").
CREATE UNIQUE INDEX IF NOT EXISTS courses_external_certification_unique
  ON courses (external_certification_id)
  WHERE external_certification_id IS NOT NULL;
