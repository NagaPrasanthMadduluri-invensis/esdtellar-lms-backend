-- Live Sessions, part 2: batches, self-enrolment and a waitlist.
--
-- Additive and idempotent (§6.2). Two new tables, two new columns, one new
-- nullable FK on an existing table. Nothing existing changes shape.
--
-- ═════════════════════════════════════════════════════════════════════════
-- THE ONE DECISION THAT MATTERS: A BATCH IS NOT A COURSE
-- ═════════════════════════════════════════════════════════════════════════
--
-- §10.7 says every session owns exactly one companion training course, with
-- one module and one lesson, and that this is what lets My Courses, hours,
-- completion, the leaderboard and certificates pick a session up through
-- definitions that already work.
--
-- Multi-batch could have been modelled as one course per batch. It must not
-- be. A learner attends exactly ONE batch of a session, and what they earn is
-- the session's training — not a different training depending on which
-- Tuesday they came. One course per batch would mean:
--
--   * "completed" stops meaning 100% of one course,
--   * two learners on the same session hold different certificates,
--   * moving somebody between batches silently withdraws one training and
--     grants another, taking their completion with it.
--
-- So: a batch is a SCHEDULING SUBDIVISION of one session's roster. The
-- session still owns one training course. `session_roster.batch_id` records
-- which sitting a learner is in; `session_attendance` keeps its (session,
-- user) shape, because a learner is in exactly one batch and so the pair is
-- still unique — which means `syncCompletions` and the completion rules in
-- §10.7 are untouched by this migration.
--
-- ═════════════════════════════════════════════════════════════════════════
-- BATCHES ARE OPTIONAL, AND THAT IS WHAT MAKES THIS SAFE
-- ═════════════════════════════════════════════════════════════════════════
--
-- A session with NO batch rows is a single sitting that uses the session's own
-- date, start_time, end_time and capacity — exactly what every session is
-- today. `batch_id IS NULL` on a roster row means "the session's own sitting".
--
-- This is the staged-lesson pattern from 0020 applied again: every existing
-- query keeps working because the new column is NULL everywhere, and no
-- backfill is needed. Had batches been mandatory, all eleven session handlers
-- and the attendance sync would have had to be rewritten in this one change.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. HOW PEOPLE GET ON A SESSION
-- ─────────────────────────────────────────────────────────────────────────
--
-- 'assigned' — an admin adds them to the roster. This is what every existing
--              session does, so it is the default and nothing changes.
-- 'self'     — learners enrol themselves until the sitting is full, then the
--              waitlist takes over.
--
-- Text, not an enum type: the catalogue is code
-- (`common/session-enrolment.ts`), the same argument `activity_log.type` and
-- `assessments.link_type` both make.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS enroll_mode text NOT NULL DEFAULT 'assigned';

-- ─────────────────────────────────────────────────────────────────────────
-- 2. BATCHES
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_batches (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  session_id      integer NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,

  -- Displayed as "Batch 1", "Batch 2". Stored rather than derived from a row
  -- number, because deleting batch 2 of three must not renumber batch 3 under
  -- people who have already been told which batch they are in.
  batch_no        integer NOT NULL,
  label           text,

  -- A batch may be created before its date is known — the reference calls
  -- that `pending` and draws it as a hatched segment. NULL date is what makes
  -- it pending; there is no separate flag to contradict.
  date            text,
  start_time      text,
  end_time        text,

  -- NULL falls back to the session's own capacity, so the common case (every
  -- batch the same size) is expressed by leaving this alone.
  capacity        integer,
  trainer_user_id integer REFERENCES users (id) ON DELETE SET NULL,

  -- scheduled | completed | cancelled. `pending` is DERIVED from a NULL date
  -- rather than stored, for the same reason `display_status` is derived on the
  -- session itself (§10.7): one fact, one place.
  status          text NOT NULL DEFAULT 'scheduled',

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Every read is "this session's batches, in order".
CREATE INDEX IF NOT EXISTS idx_session_batches_session
  ON session_batches (session_id, batch_no);
CREATE INDEX IF NOT EXISTS idx_session_batches_org
  ON session_batches (organization_id, session_id);

-- Two batches of one session cannot share a number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_batches_session_no
  ON session_batches (session_id, batch_no);

-- Which sitting a rostered learner is in. NULL = the session's own sitting,
-- which is every existing row. ON DELETE SET NULL: deleting a batch must not
-- unenrol the people in it — they fall back to the session's own sitting and
-- the admin re-assigns them, the same choice 0020 made for lessons losing
-- their module.
ALTER TABLE session_roster
  ADD COLUMN IF NOT EXISTS batch_id integer
    REFERENCES session_batches (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_session_roster_batch
  ON session_roster (batch_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. WAITLIST
-- ─────────────────────────────────────────────────────────────────────────
--
-- Only self-enrol sessions produce one: an admin adding somebody to a full
-- roster is a deliberate override, not a queue.
--
-- Deliberately NOT a status on `session_roster`. A waitlisted person is not
-- enrolled — they hold no `user_course_assignments` row, the session's
-- training does not appear in their My Courses, and they must not be counted
-- in the roster or credited by attendance. Folding them into the roster with
-- a flag would mean every one of those queries needing a new predicate, and
-- the first one that forgot would enrol somebody who is still queuing.

CREATE TABLE IF NOT EXISTS session_waitlist (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  session_id      integer NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Position is by arrival, so the queue needs no explicit rank column.
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_waitlist_unique
  ON session_waitlist (session_id, user_id);
CREATE INDEX IF NOT EXISTS idx_session_waitlist_session
  ON session_waitlist (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_waitlist_org
  ON session_waitlist (organization_id, session_id);
