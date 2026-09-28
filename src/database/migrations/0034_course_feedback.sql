-- Course feedback: editable templates, and what learners said.
--
-- Additive and idempotent (§6.2). Three tables, two columns on `courses`,
-- and a per-organization seed of the three default templates.
--
-- =========================================================================
-- THIS IS NOT `session_feedback`, AND THE DIFFERENCE IS THE SUBJECT
-- =========================================================================
--
-- `session_feedback` (0032) asks three fixed questions about a SITTING a
-- learner attended, and the trainer reads it without names. This asks about
-- a COURSE, the questions are whatever the admin wrote, and the admin reads
-- it. Folding them together would mean one table whose columns are
-- meaningful for half its rows.
--
-- What they share is the rule that matters, and it is repeated here rather
-- than assumed: FEEDBACK IS NEVER PART OF COMPLETION. Nothing in
-- `CertificatesService.evaluate()` or the completion definition (§10.11)
-- reads these tables. A learner who never gives feedback still finishes the
-- course, still earns the hours, still gets the certificate.
--
-- =========================================================================
-- ANSWERS ARE A JSONB DOCUMENT, WITH A STATED COST
-- =========================================================================
--
-- The owner chose a full question builder: an admin may add a rating, an
-- agree-scale, a multiple choice, a yes/no or an open text question to any
-- template. The set of questions is therefore per-template data, not a fixed
-- shape, and answers are keyed by question id.
--
-- §10.14 already records what this costs, and it applies unchanged:
-- `answers` is NOT queryable as structured data. "Average rating across
-- Technical courses" is not a SELECT over this column. Anything that needs
-- to be reported on must first be PROMOTED to a real column, the way
-- `timeline` and `budget` were promoted out of `service_requests.answers`.
--
-- =========================================================================
-- WHICH TEMPLATE A COURSE USES
-- =========================================================================
--
--   feedback_enabled = 0        -> no feedback on this course at all
--   feedback_template_id SET    -> that template, whatever the category says
--   feedback_template_id NULL   -> resolved from the course's CATEGORY:
--                                  Technical -> technical, Compliance ->
--                                  compliance, everything else -> standard
--
-- Two columns rather than one sentinel, because "off" and "which one" are
-- different questions and a single nullable id cannot carry both. NULL is
-- the default, so every existing course follows its category with no
-- backfill and no course form needing to be opened.
--
-- ON DELETE SET NULL on the override: deleting a template must not delete
-- the courses pointing at it, it must drop them back to their category
-- default — which is a working state, not a broken one.

CREATE TABLE IF NOT EXISTS feedback_templates (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- 'standard' | 'technical' | 'compliance' for the three seeded ones, and a
  -- generated key for anything an admin adds. Unique per org so the category
  -- resolver can look one up by name without an id it would have to store.
  key             text    NOT NULL,
  name            text    NOT NULL,
  description     text,

  -- A seeded template. Its KEY is what the category resolver depends on, so
  -- a system template may be renamed and re-questioned but not deleted --
  -- deleting 'technical' would leave every Technical course resolving to
  -- nothing with no way for an admin to see why.
  is_system       integer NOT NULL DEFAULT 0,
  is_active       integer NOT NULL DEFAULT 1,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (organization_id, key)
);

CREATE TABLE IF NOT EXISTS feedback_template_questions (
  id            serial PRIMARY KEY,
  template_id   integer NOT NULL REFERENCES feedback_templates (id) ON DELETE CASCADE,

  -- The order the learner sees them in. Stored, because a survey that
  -- reorders itself between two learners is two different surveys.
  sort_order    integer NOT NULL DEFAULT 0,

  -- One of the five in `common/feedback-questions.ts`: rating, likert,
  -- choice, yesno, text. Validated there, not by a CHECK -- the catalogue is
  -- code and a new type should not need a migration.
  question_type text    NOT NULL,
  prompt        text    NOT NULL,

  -- Only for `choice`. A jsonb array of strings.
  options       jsonb,

  is_required   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_questions_template
  ON feedback_template_questions (template_id, sort_order);

CREATE TABLE IF NOT EXISTS course_feedback (
  id              serial PRIMARY KEY,

  -- ACTIVITY, so `orgScope` and never `contentScope` (§10.12). The COURSE may
  -- be platform-owned and shared; an opinion about it belongs to one tenant.
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  course_id       integer NOT NULL REFERENCES courses (id) ON DELETE CASCADE,

  -- The author. Stored so one learner cannot rate a course twice and so an
  -- admin can attribute an abusive comment. The admin DOES see it -- unlike
  -- session feedback, where the trainer never does (0032).
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- Which template they were shown. Kept even if the template is later
  -- edited or deleted, because the answers are keyed by ITS question ids and
  -- reading them back without knowing which form they came from is
  -- guesswork.
  template_id     integer REFERENCES feedback_templates (id) ON DELETE SET NULL,

  -- { "<question_id>": <answer> }. See the header for the cost.
  answers         jsonb   NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (course_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_course_feedback_course
  ON course_feedback (course_id);
CREATE INDEX IF NOT EXISTS idx_course_feedback_org_created
  ON course_feedback (organization_id, created_at DESC);

-- ── Per-course configuration ──
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS feedback_enabled integer NOT NULL DEFAULT 1;
ALTER TABLE courses
  ADD COLUMN IF NOT EXISTS feedback_template_id integer
  REFERENCES feedback_templates (id) ON DELETE SET NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- SEED: three templates per tenant, with their default questions.
--
-- Per TENANT, not globally: a template is editable, and an org editing the
-- shared copy would rewrite everybody's form. The platform org is skipped --
-- it authors courses but has no learners of its own to survey.
--
-- Idempotent by the UNIQUE (organization_id, key) and a NOT EXISTS on the
-- questions, so a re-run adds nothing and never duplicates a question an
-- admin has since edited.
-- ═════════════════════════════════════════════════════════════════════════

INSERT INTO feedback_templates (organization_id, key, name, description, is_system)
SELECT o.id, t.key, t.name, t.description, 1
  FROM organizations o
 CROSS JOIN (VALUES
   ('standard',   'Standard course feedback',
    'The default for every category that has no template of its own, and for any course an admin points at it.'),
   ('technical',  'Technical course feedback',
    'Attached automatically to courses in the Technical category.'),
   ('compliance', 'Compliance course feedback',
    'Attached automatically to courses in the Compliance category.')
 ) AS t(key, name, description)
 WHERE NOT o.is_platform
ON CONFLICT (organization_id, key) DO NOTHING;

INSERT INTO feedback_template_questions (template_id, sort_order, question_type, prompt, options, is_required)
SELECT ft.id, q.sort_order, q.question_type, q.prompt, q.options::jsonb, q.is_required
  FROM feedback_templates ft
  JOIN (VALUES
    -- standard
    ('standard',   1, 'rating', 'Overall, how would you rate this course?',                NULL, 1),
    ('standard',   2, 'rating', 'How would you rate the quality of the content?',          NULL, 1),
    ('standard',   3, 'yesno',  'Would you recommend this course to a colleague?',         NULL, 0),
    ('standard',   4, 'text',   'What did you find most valuable?',                        NULL, 0),
    ('standard',   5, 'text',   'What could be improved?',                                 NULL, 0),
    -- technical
    ('technical',  1, 'rating', 'Overall, how would you rate this course?',                NULL, 1),
    ('technical',  2, 'rating', 'How would you rate the depth of the technical content?',  NULL, 1),
    ('technical',  3, 'likert', 'The examples and exercises reflected real work.',         NULL, 0),
    ('technical',  4, 'choice', 'Was the level right for you?',
       '["Too basic","About right","Too advanced"]', 0),
    ('technical',  5, 'text',   'Which topic would you like covered in more depth?',       NULL, 0),
    -- compliance
    ('compliance', 1, 'rating', 'Overall, how would you rate this training?',              NULL, 1),
    ('compliance', 2, 'likert', 'The training made my responsibilities clear.',            NULL, 1),
    ('compliance', 3, 'choice', 'Do you know who to contact if you need to raise a concern?',
       '["Yes","I think so","No"]', 1),
    ('compliance', 4, 'yesno',  'Do you need any further support on this topic?',          NULL, 0),
    ('compliance', 5, 'text',   'Anything you would like to add?',                         NULL, 0)
  ) AS q(key, sort_order, question_type, prompt, options, is_required)
    ON q.key = ft.key
 WHERE ft.is_system = 1
   AND NOT EXISTS (
     SELECT 1 FROM feedback_template_questions x WHERE x.template_id = ft.id
   );
