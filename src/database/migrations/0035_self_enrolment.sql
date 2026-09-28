-- Self-enrolment: one column on `courses`, and the index the catalogue reads.
--
-- Additive and idempotent (§6.2). Nothing is backfilled and nothing changes
-- behaviour for an existing row: the default is 0, so every course that
-- exists today stays invisible to the Course Catalogue until an admin
-- deliberately opens it. Defaulting to 1 would have published every course in
-- every tenant to every learner on deploy, which is the loudest possible
-- version of a silent change.
--
-- =========================================================================
-- SESSIONS ALREADY HAD THIS, AND THAT IS WHY THERE IS ONLY ONE COLUMN HERE
-- =========================================================================
--
-- `sessions.enroll_mode` ('assigned' | 'self') and `session_waitlist` both
-- arrived with `0025_session_batches.sql`. What was missing was not the data
-- model but every trigger for it: no admin control set the mode, and no
-- learner route acted on it. TASTE §10.3.1.17 recorded the consequence in
-- writing — "there is no learner self-enrolment endpoint in this product, so
-- a Register button would be a control that does nothing."
--
-- So this migration adds the COURSE half and the rest of the change is code.
-- A second column named `self_enrol` on `sessions` would have been a second
-- vocabulary for the state `enroll_mode` already carries.
--
-- =========================================================================
-- WHY A BOOLEAN AND NOT A MODE
-- =========================================================================
--
-- A session's enrolment is a MODE because the two values are exclusive: an
-- admin either books people onto a sitting or learners book themselves, and
-- a seat is a finite thing that one of the two must own.
--
-- A course has no seats. Self-enrolment there is strictly ADDITIVE — an admin
-- may still assign it to a department while learners also find it in the
-- catalogue, and both rows land in the same `user_course_assignments` table.
-- Modelling it as a mode would have forced a choice the product does not
-- need to make.
--
-- =========================================================================
-- HOW A SELF-ENROLLED ROW IS TOLD APART
-- =========================================================================
--
-- `user_course_assignments.assigned_by = user_id`. No new column: a row a
-- learner created for themselves is precisely one whose assigner is the
-- assignee, and that is already recorded. §10.12 notes that the reports
-- builder dropped its self-vs-assigned enrolment split because "there is no
-- self-enrolment in this product, so the split would be 100%/0% by
-- construction" — that premise is now gone, and the split is expressible
-- from the column that already exists if anybody asks for the report.

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS self_enrol integer NOT NULL DEFAULT 0;

-- The catalogue read: this org's (and the platform's) open courses. Partial,
-- because the rows it serves are a small minority of the table and an index
-- over every course to find the open ones is mostly dead weight.
CREATE INDEX IF NOT EXISTS idx_courses_self_enrol
  ON courses (organization_id)
  WHERE self_enrol = 1 AND archived_at IS NULL;

-- The catalogue's session half filters on the mode that already existed, and
-- nothing indexed it — the sessions list has always filtered by org + date
-- instead. Partial for the same reason.
CREATE INDEX IF NOT EXISTS idx_sessions_self_enrol
  ON sessions (organization_id, date)
  WHERE enroll_mode = 'self' AND archived_at IS NULL;
