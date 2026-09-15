-- Learning journeys, data foundation. Spec: specs/learning-journeys.md §3.
--
-- Everything here is additive and idempotent (BACKEND_STRUCTURE.md §6.2) --
-- CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS throughout, safe to re-run on every boot. The non-additive half --
-- relaxing certificates.course_id to nullable, its unique constraint split
-- into two partial indexes, and the CHECK that exactly one of course_id /
-- journey_id is set -- is a human checkpoint in
-- scripts/migrate-journey-certificates.mjs, matching db:reset-to-admin
-- (§3.4, §6.2). That script also backfills the nine existing badges via
-- user_badges for whoever already qualifies.
--
-- WHAT THIS MODELS. A journey (journeys) is an ordered, curated path of
-- existing courses (journey_courses) -- content, scoped like a course. Who is
-- on a journey and when they finished (journey_enrollments) is activity,
-- scoped like an assignment. Only completed_at is stored there -- percentage
-- and current step are derived from user_lesson_completions, the same way a
-- session's in-progress state is derived rather than stored (§10.7). Badges
-- move from being recomputed on every read in learner.service.ts into a real
-- table, user_badges, keyed by a catalogue that is code
-- (src/common/badges.ts) for the same reason the permission catalogue is
-- code: a badge key means something only because an award rule references it.
--
-- Two columns land on existing tables in this file, both nullable and both
-- additive on their own:
--
--   certificates.journey_id             set for a journey certificate instead
--                                        of a course one. The NOT NULL drop on
--                                        course_id and the CHECK that makes
--                                        the two mutually exclusive are the
--                                        checkpoint above -- until that runs,
--                                        this column simply sits unused.
--   user_course_assignments.source_journey_id
--                                        NULL means an admin assigned the
--                                        course directly and it is always
--                                        open. A value means the row exists
--                                        only because that journey assigned
--                                        it, and is gated by the journey's
--                                        sequence (§4.3). Assigning a journey
--                                        never overwrites an existing row, so
--                                        a pre-existing direct assignment
--                                        keeps its NULL.

CREATE TABLE IF NOT EXISTS journeys (
  id              serial      PRIMARY KEY,
  organization_id integer     NOT NULL,
  title           text        NOT NULL,
  description     text,
  tag             text,
  skills          text,
  thumbnail_url   text,
  badge_label     text        NOT NULL,
  badge_icon      text        NOT NULL DEFAULT 'award',
  points_bonus    integer     NOT NULL DEFAULT 200,
  is_active       integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journey_courses (
  id              serial  PRIMARY KEY,
  organization_id integer NOT NULL,
  journey_id      integer NOT NULL REFERENCES journeys (id) ON DELETE CASCADE,
  course_id       integer NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  sort_order      integer NOT NULL DEFAULT 0,
  is_required     integer NOT NULL DEFAULT 1,
  -- A course appears at most once in a journey.
  UNIQUE (journey_id, course_id)
);

CREATE TABLE IF NOT EXISTS journey_enrollments (
  id              serial      PRIMARY KEY,
  organization_id integer     NOT NULL,
  journey_id      integer     NOT NULL REFERENCES journeys (id) ON DELETE CASCADE,
  user_id         integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  assigned_by     integer     REFERENCES users (id),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  due_date        text,
  completed_at    timestamptz,
  UNIQUE (user_id, journey_id)
);

CREATE TABLE IF NOT EXISTS user_badges (
  id              serial      PRIMARY KEY,
  organization_id integer     NOT NULL,
  user_id         integer     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  badge_key       text        NOT NULL,
  journey_id      integer     REFERENCES journeys (id) ON DELETE CASCADE,
  earned_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, badge_key)
);

-- Catalogue and admin lists filter by org + active status (§3.1).
CREATE INDEX IF NOT EXISTS idx_journeys_org_active ON journeys (organization_id, is_active);

-- Reverse lookup: which journeys contain a given course, read by
-- JourneysService.onCourseProgress on every completion trigger (§4.2).
CREATE INDEX IF NOT EXISTS idx_journey_courses_course ON journey_courses (course_id);

-- Per-learner journey lists and enrollment lookups.
CREATE INDEX IF NOT EXISTS idx_je_org_user ON journey_enrollments (organization_id, user_id);

-- Per-learner badge lists and award-idempotency checks.
CREATE INDEX IF NOT EXISTS idx_user_badges_org_user ON user_badges (organization_id, user_id);

-- §3.4 (additive half only -- see the checkpoint script for the rest).
ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS journey_id integer REFERENCES journeys (id) ON DELETE CASCADE;

-- §3.5.
ALTER TABLE user_course_assignments
  ADD COLUMN IF NOT EXISTS source_journey_id integer REFERENCES journeys (id) ON DELETE SET NULL;
