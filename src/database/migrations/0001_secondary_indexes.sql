-- Additive-only migration: secondary indexes.
--
-- The 18 tables already exist in Turso with production data, so this file never
-- creates or alters a table. Every statement is CREATE INDEX IF NOT EXISTS,
-- which is safe to re-run on every boot — the same idempotent posture the
-- legacy lib/db/schema.js used.
--
-- Indexes that would duplicate an existing UNIQUE constraint's leftmost prefix
-- are deliberately omitted (SQLite already has a usable index for those).

-- users: learner lists and department analytics
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users (role, is_active);
CREATE INDEX IF NOT EXISTS idx_users_department ON users (department);

-- course tree: every progress calculation walks course -> modules -> lessons
CREATE INDEX IF NOT EXISTS idx_courses_active ON courses (is_active);
CREATE INDEX IF NOT EXISTS idx_course_modules_course ON course_modules (course_id, is_active);
CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons (module_id, is_active);

-- enrollment + completion
CREATE INDEX IF NOT EXISTS idx_assignments_course ON user_course_assignments (course_id);
CREATE INDEX IF NOT EXISTS idx_completions_lesson ON user_lesson_completions (lesson_id);

-- assessments: best-score lookups run on every course-progress read
CREATE INDEX IF NOT EXISTS idx_assessments_course ON assessments (course_id, is_active);
CREATE INDEX IF NOT EXISTS idx_questions_assessment ON assessment_questions (assessment_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_options_question ON assessment_options (question_id);
CREATE INDEX IF NOT EXISTS idx_attempts_user_assessment ON user_assessment_attempts (user_id, assessment_id);
CREATE INDEX IF NOT EXISTS idx_answers_attempt ON user_assessment_answers (attempt_id);

-- sessions + attendance
CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions (date);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
CREATE INDEX IF NOT EXISTS idx_roster_user ON session_roster (user_id);
CREATE INDEX IF NOT EXISTS idx_attendance_user ON session_attendance (user_id);

-- scorm
CREATE INDEX IF NOT EXISTS idx_scorm_packages_active ON scorm_packages (is_active);
CREATE INDEX IF NOT EXISTS idx_scorm_assignments_package ON user_scorm_assignments (package_id);
CREATE INDEX IF NOT EXISTS idx_scorm_tracking_package ON scorm_tracking (package_id);

-- certificates
CREATE INDEX IF NOT EXISTS idx_certificates_course ON certificates (course_id);
