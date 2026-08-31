-- A live/offline session IS a training assignment, not only a calendar event.
--
-- Rather than teach My Courses, learning hours, progress, dashboards and
-- certificates about a second kind of enrolment, each session gets a companion
-- course holding exactly one lesson (content_type = 'session'). Roster
-- membership then becomes an ordinary user_course_assignments row and session
-- completion an ordinary user_lesson_completions row, so every aggregate that
-- already reads those tables picks the session up with no new code path and no
-- second definition of "an hour of learning" (BACKEND_STRUCTURE 7.1, 10.4).
--
-- The link lives on the course, pointing back at the session, for two reasons:
-- the backfill below can then be written as set-based INSERT ... SELECTs with
-- no way to lose track of which course belongs to which session, and
-- ON DELETE CASCADE makes deleting a session tear down its training course,
-- assignments and completions without any application-side cleanup.

ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS session_id integer
    REFERENCES sessions (id) ON DELETE CASCADE;

-- One training course per session. Also the index for "is this a session
-- training?", which the admin course list and the certificate guard both ask.
CREATE UNIQUE INDEX IF NOT EXISTS courses_session_unique
  ON courses (session_id);

-- ── Backfill: existing sessions and rosters become trainings ─────────────
--
-- This migration runs BEFORE `0007_organizations.sql` in filename order, so
-- on a genuinely fresh database `organization_id` does not exist yet on any
-- of the five tables below when this file executes — referencing it
-- unconditionally would fail to even parse. On a database where multi-tenancy
-- has already landed, though, `organization_id` is `NOT NULL` on all of them
-- (phase 3, `scripts/migrate-tenancy.mjs`), so the plain INSERTs below would
-- violate that constraint on every boot.
--
-- Each step below is therefore guarded by a `DO $$ ... END $$` block that
-- checks `information_schema.columns` for the column at runtime and
-- `EXECUTE`s one of two dynamic SQL strings: the org-aware variant when the
-- column exists, the original pre-tenancy variant when it does not. Only the
-- branch actually taken is ever parsed/planned, so neither variant needs the
-- column to exist. The `ON CONFLICT` / `WHERE NOT EXISTS` guards inside each
-- variant are unchanged and keep the whole thing idempotent and re-runnable
-- on every boot, in both worlds.
--
-- Which org each insert carries follows BACKEND_STRUCTURE §3.3 / spec §3.3:
-- content carries the owner's org, activity carries the learner's.

-- 1. The companion course. Cancelled sessions are born inactive so their card
--    does not appear in My Courses (the learner list joins on is_active = 1).
--    Content: carries the session's own org.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'courses'
      AND column_name = 'organization_id'
  ) THEN
    EXECUTE $ins$
      INSERT INTO courses (name, description, is_active, session_id, organization_id)
      SELECT s.title,
             COALESCE(
               NULLIF(s.description, ''),
               s.session_type || ' session with ' || s.trainer || ' on ' || s.date
             ),
             CASE WHEN s.status = 'cancelled' THEN 0 ELSE 1 END,
             s.id,
             s.organization_id
      FROM sessions s
      WHERE NOT EXISTS (SELECT 1 FROM courses c WHERE c.session_id = s.id);
    $ins$;
  ELSE
    EXECUTE $ins$
      INSERT INTO courses (name, description, is_active, session_id)
      SELECT s.title,
             COALESCE(
               NULLIF(s.description, ''),
               s.session_type || ' session with ' || s.trainer || ' on ' || s.date
             ),
             CASE WHEN s.status = 'cancelled' THEN 0 ELSE 1 END,
             s.id
      FROM sessions s
      WHERE NOT EXISTS (SELECT 1 FROM courses c WHERE c.session_id = s.id);
    $ins$;
  END IF;
END $$;

-- 2. One module to hang the lesson from. Content: carries its course's org.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'course_modules'
      AND column_name = 'organization_id'
  ) THEN
    EXECUTE $ins$
      INSERT INTO course_modules (course_id, title, description, sort_order, is_active, organization_id)
      SELECT c.id, 'Live session', NULL, 0, 1, c.organization_id
      FROM courses c
      WHERE c.session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM course_modules cm WHERE cm.course_id = c.id
        );
    $ins$;
  ELSE
    EXECUTE $ins$
      INSERT INTO course_modules (course_id, title, description, sort_order, is_active)
      SELECT c.id, 'Live session', NULL, 0, 1
      FROM courses c
      WHERE c.session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM course_modules cm WHERE cm.course_id = c.id
        );
    $ins$;
  END IF;
END $$;

-- 3. The lesson that carries the session. duration_minutes is what learning
--    hours credits on completion, so it is the scheduled length of the sitting.
--    An end time at or before the start time (bad data) yields 0 rather than a
--    negative that would subtract hours from the learner's total.
--    Content: carries its module's org.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'lessons'
      AND column_name = 'organization_id'
  ) THEN
    EXECUTE $ins$
      INSERT INTO lessons (module_id, title, description, content_type, content_url,
                           duration_minutes, sort_order, is_preview, is_active, organization_id)
      SELECT cm.id, s.title, s.description, 'session', s.venue_url,
             GREATEST(
               0,
               (EXTRACT(EPOCH FROM (s.end_time::time - s.start_time::time)) / 60)::int
             ),
             0, 0, 1, cm.organization_id
      FROM course_modules cm
      JOIN courses c ON c.id = cm.course_id
      JOIN sessions s ON s.id = c.session_id
      WHERE NOT EXISTS (SELECT 1 FROM lessons l WHERE l.module_id = cm.id);
    $ins$;
  ELSE
    EXECUTE $ins$
      INSERT INTO lessons (module_id, title, description, content_type, content_url,
                           duration_minutes, sort_order, is_preview, is_active)
      SELECT cm.id, s.title, s.description, 'session', s.venue_url,
             GREATEST(
               0,
               (EXTRACT(EPOCH FROM (s.end_time::time - s.start_time::time)) / 60)::int
             ),
             0, 0, 1
      FROM course_modules cm
      JOIN courses c ON c.id = cm.course_id
      JOIN sessions s ON s.id = c.session_id
      WHERE NOT EXISTS (SELECT 1 FROM lessons l WHERE l.module_id = cm.id);
    $ins$;
  END IF;
END $$;

-- 4. Roster membership becomes a course assignment. assigned_by is null: the
--    admin who did the original enrolment was never recorded on the roster.
--    Activity: carries the learner's (the roster user's) org.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'user_course_assignments'
      AND column_name = 'organization_id'
  ) THEN
    EXECUTE $ins$
      INSERT INTO user_course_assignments (user_id, course_id, assigned_by, assigned_at, due_date, organization_id)
      SELECT sr.user_id, c.id, NULL, sr.enrolled_at, s.date, u.organization_id
      FROM session_roster sr
      JOIN courses c ON c.session_id = sr.session_id
      JOIN sessions s ON s.id = sr.session_id
      JOIN users u ON u.id = sr.user_id
      ON CONFLICT (user_id, course_id) DO NOTHING;
    $ins$;
  ELSE
    EXECUTE $ins$
      INSERT INTO user_course_assignments (user_id, course_id, assigned_by, assigned_at, due_date)
      SELECT sr.user_id, c.id, NULL, sr.enrolled_at, s.date
      FROM session_roster sr
      JOIN courses c ON c.session_id = sr.session_id
      JOIN sessions s ON s.id = sr.session_id
      ON CONFLICT (user_id, course_id) DO NOTHING;
    $ins$;
  END IF;
END $$;

-- 5. Sessions already marked completed credit the learners who attended.
--    present / late / partial count; absent and excused do not, and neither
--    does an unmarked attendance row.
--    Activity: carries the learner's (the attendee's) org.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'user_lesson_completions'
      AND column_name = 'organization_id'
  ) THEN
    EXECUTE $ins$
      INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at, organization_id)
      SELECT sa.user_id, l.id,
             LEAST(now(), (s.date::date + s.end_time::time)::timestamptz),
             u.organization_id
      FROM session_attendance sa
      JOIN sessions s ON s.id = sa.session_id
      JOIN courses c ON c.session_id = s.id
      JOIN course_modules cm ON cm.course_id = c.id
      JOIN lessons l ON l.module_id = cm.id AND l.content_type = 'session'
      JOIN users u ON u.id = sa.user_id
      WHERE s.status = 'completed'
        AND sa.status IN ('present', 'late', 'partial')
      ON CONFLICT (user_id, lesson_id) DO NOTHING;
    $ins$;
  ELSE
    EXECUTE $ins$
      INSERT INTO user_lesson_completions (user_id, lesson_id, completed_at)
      SELECT sa.user_id, l.id,
             LEAST(now(), (s.date::date + s.end_time::time)::timestamptz)
      FROM session_attendance sa
      JOIN sessions s ON s.id = sa.session_id
      JOIN courses c ON c.session_id = s.id
      JOIN course_modules cm ON cm.course_id = c.id
      JOIN lessons l ON l.module_id = cm.id AND l.content_type = 'session'
      WHERE s.status = 'completed'
        AND sa.status IN ('present', 'late', 'partial')
      ON CONFLICT (user_id, lesson_id) DO NOTHING;
    $ins$;
  END IF;
END $$;
