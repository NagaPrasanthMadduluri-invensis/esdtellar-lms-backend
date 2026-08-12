-- Baseline schema — the authoritative DDL for all 18 tables.
--
-- This is the definition that used to live in client/lib/db/schema.js. It now
-- lives here, and only here: the server owns the database.
--
-- Every statement is CREATE TABLE IF NOT EXISTS, so running it against the
-- existing Turso database is a no-op, while a fresh/empty database is created
-- correctly from scratch. Runs before 0001 (filename order).
--
-- Columns that the legacy code added through `try { ALTER TABLE ... } catch {}`
-- (users.employee_id / location / job_role, user_course_assignments.due_date,
-- lessons.scorm_package_id) are declared inline here instead. The result is the
-- same shape, without needing a statement that is expected to fail.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name  TEXT    NOT NULL,
  last_name   TEXT    NOT NULL,
  email       TEXT    NOT NULL UNIQUE,
  password    TEXT    NOT NULL,
  role        TEXT    NOT NULL DEFAULT 'learner',
  department  TEXT,
  employee_id TEXT,
  location    TEXT,
  job_role    TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  description   TEXT,
  thumbnail_url TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS course_modules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scorm_packages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  version     TEXT    NOT NULL DEFAULT '1.2',
  entry_point TEXT    NOT NULL,
  package_dir TEXT    NOT NULL UNIQUE,
  course_id   INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  created_by  INTEGER REFERENCES users(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id        INTEGER NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  title            TEXT    NOT NULL,
  description      TEXT,
  content_type     TEXT    NOT NULL DEFAULT 'video',
  content_url      TEXT,
  scorm_package_id INTEGER REFERENCES scorm_packages(id) ON DELETE SET NULL,
  duration_minutes INTEGER,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_preview       INTEGER NOT NULL DEFAULT 0,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assessments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id     INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  description   TEXT,
  passing_score INTEGER NOT NULL DEFAULT 60,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assessment_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_id INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_text TEXT    NOT NULL,
  marks         INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assessment_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
  option_text TEXT    NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_course_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT    NOT NULL DEFAULT (datetime('now')),
  due_date    TEXT,
  UNIQUE(user_id, course_id)
);

CREATE TABLE IF NOT EXISTS user_lesson_completions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id    INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS user_assessment_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assessment_id   INTEGER NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  score           INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  percentage      INTEGER NOT NULL DEFAULT 0,
  is_passed       INTEGER NOT NULL DEFAULT 0,
  submitted_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_assessment_answers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id         INTEGER NOT NULL REFERENCES user_assessment_attempts(id) ON DELETE CASCADE,
  question_id        INTEGER NOT NULL REFERENCES assessment_questions(id),
  selected_option_id INTEGER REFERENCES assessment_options(id),
  is_correct         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT    NOT NULL,
  session_type TEXT    NOT NULL DEFAULT 'ILT',
  department   TEXT,
  course_id    INTEGER REFERENCES courses(id) ON DELETE SET NULL,
  capacity     INTEGER NOT NULL DEFAULT 20,
  trainer      TEXT    NOT NULL,
  venue_url    TEXT    NOT NULL,
  date         TEXT    NOT NULL,
  start_time   TEXT    NOT NULL,
  end_time     TEXT    NOT NULL,
  description  TEXT,
  status       TEXT    NOT NULL DEFAULT 'upcoming',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_roster (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enrolled_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, user_id)
);

CREATE TABLE IF NOT EXISTS session_attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     TEXT,
  join_time  TEXT,
  notes      TEXT,
  marked_by  INTEGER REFERENCES users(id),
  is_locked  INTEGER NOT NULL DEFAULT 0,
  marked_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_scorm_assignments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id  INTEGER NOT NULL REFERENCES scorm_packages(id) ON DELETE CASCADE,
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, package_id)
);

CREATE TABLE IF NOT EXISTS scorm_tracking (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package_id        INTEGER NOT NULL REFERENCES scorm_packages(id) ON DELETE CASCADE,
  lesson_status     TEXT    DEFAULT 'not attempted',
  completion_status TEXT    DEFAULT 'unknown',
  success_status    TEXT    DEFAULT 'unknown',
  score_raw         REAL,
  score_min         REAL,
  score_max         REAL,
  total_time        TEXT,
  suspend_data      TEXT,
  location          TEXT,
  cmi_data          TEXT    NOT NULL DEFAULT '{}',
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, package_id)
);

CREATE TABLE IF NOT EXISTS certificates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id        INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  certificate_code TEXT    UNIQUE NOT NULL,
  issued_at        TEXT    NOT NULL,
  final_score      INTEGER,
  is_revoked       INTEGER NOT NULL DEFAULT 0,
  revoked_at       TEXT,
  revoked_by       INTEGER REFERENCES users(id),
  UNIQUE(user_id, course_id)
);
