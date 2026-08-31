-- ===========================================================================
-- 0008 — organization-leading indexes for the tables phase 4 made query roots
--
-- Phase 4 threaded OrgScope through all 12 repositories, and in doing so it
-- turned several tables into scoped query ROOTS that had only child-column
-- indexes before. Without an organization-leading index those reads degrade
-- from "bounded by this org's size" to "bounded by the whole platform's" —
-- exactly the regression the performance budget in specs/multi-tenancy.md
-- §3.8 exists to prevent, and the one that measured 851 ms against 55 ms.
--
-- Only the tables actually filtered on organization_id at a query root are
-- listed. An index that no query would use is a write cost with no read
-- benefit, so the remaining tenant tables are deliberately left alone: they
-- are always reached through an already-scoped parent.
-- ===========================================================================

-- LearningHoursRepository.lessonSource scans this on every dashboard,
-- leaderboard and learning-hours read.
CREATE INDEX IF NOT EXISTS idx_video_progress_org_user
  ON lesson_video_progress (organization_id, user_id);

-- scormTimes / scormTimesByCourse, same read paths.
CREATE INDEX IF NOT EXISTS idx_scorm_tracking_org_user
  ON scorm_tracking (organization_id, user_id);

-- The admin SCORM library, and the entitlement join behind every package
-- launch.
CREATE INDEX IF NOT EXISTS idx_scorm_packages_org_active
  ON scorm_packages (organization_id, is_active);

-- Attempt history, read per learner in the admin detail view.
CREATE INDEX IF NOT EXISTS idx_scorm_attempts_org_user
  ON scorm_attempts (organization_id, user_id);

-- Roster and attendance are scoped roots on the sessions detail screens.
CREATE INDEX IF NOT EXISTS idx_session_roster_org_session
  ON session_roster (organization_id, session_id);
CREATE INDEX IF NOT EXISTS idx_session_attendance_org_session
  ON session_attendance (organization_id, session_id);

-- Assignment lookups when an admin assigns a package.
CREATE INDEX IF NOT EXISTS idx_scorm_assignments_org_user
  ON user_scorm_assignments (organization_id, user_id);

-- Lesson resources are listed per lesson within an org.
CREATE INDEX IF NOT EXISTS idx_lesson_resources_org_lesson
  ON lesson_resources (organization_id, lesson_id);
