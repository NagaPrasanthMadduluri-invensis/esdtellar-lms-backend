-- Course authoring: lessons decoupled from modules, assessments attachable at
-- three levels, and the full set of lesson content types.
--
-- Additive and idempotent (§6.2) throughout. The one column that CHANGES is
-- `lessons.module_id`, which is relaxed from NOT NULL to nullable — a
-- widening, so no existing row becomes invalid and no existing query breaks.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 1. LESSONS BELONG TO A COURSE, AND MAY BELONG TO A MODULE
-- ─────────────────────────────────────────────────────────────────────────
--
-- A lesson used to reach its course only through its module, so it could not
-- exist without one. The authoring flow the Course Library page needs is the
-- reverse: write the lessons, then arrange them into modules — and move one
-- between modules without deleting and re-creating it.
--
-- `course_id` is backfilled from the module, so every existing lesson keeps
-- exactly the course it already had. `module_id` then becomes nullable.
--
-- WHAT AN UNLINKED LESSON IS, AND WHY THAT MATTERS. A lesson with
-- `module_id IS NULL` is STAGED: authored, but not yet part of the delivered
-- course. It does not appear to a learner, does not count toward learning
-- hours (§10.4), does not count toward course completion (§10.11) and cannot
-- earn a certificate.
--
-- That is not an accident of the schema — it is the reason this migration is
-- safe. Every one of the ~89 queries that reaches a lesson through
-- `JOIN course_modules cm ON cm.id = l.module_id` continues to work
-- unchanged, and a NULL module_id simply drops out of the join. Had unlinked
-- lessons been meant to count, all 89 would have had to be rewritten to go
-- through `course_id` instead, and four documented single-definition
-- invariants — hours, completion, the journey gate, certificates — would each
-- have needed re-proving.
--
-- So: if you ever decide an unlinked lesson SHOULD count, that is not a
-- one-line change. Read this paragraph again first.

ALTER TABLE lessons
  ADD COLUMN IF NOT EXISTS course_id integer;

UPDATE lessons l
   SET course_id = cm.course_id
  FROM course_modules cm
 WHERE cm.id = l.module_id AND l.course_id IS NULL;

-- Only after the backfill, and only if every row now has one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lessons WHERE course_id IS NULL) THEN
    ALTER TABLE lessons ALTER COLUMN course_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE lessons ALTER COLUMN module_id DROP NOT NULL;

-- Listing a course's lessons, and finding the staged ones.
CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons (course_id, module_id);

-- DELETING A MODULE NOW UNLINKS ITS LESSONS RATHER THAN DELETING THEM.
--
-- Both foreign keys were ON DELETE CASCADE, which was the only coherent rule
-- while a lesson could not exist without a module. Now that it can, cascade is
-- the wrong one: removing a grouping would destroy the work inside it, and an
-- admin reorganising a course into different modules would lose every lesson
-- on the way. SET NULL returns them to staged, where they can be re-linked.
--
-- Idempotent: DROP ... IF EXISTS then ADD, so re-running replaces like for
-- like. The composite key is rebuilt the same way; it carries organization_id
-- and so must allow NULL on the module half, which MATCH SIMPLE (the default)
-- already does — a row with a NULL in any column of a composite FK is not
-- checked.
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS lessons_module_id_fkey;
ALTER TABLE lessons ADD CONSTRAINT lessons_module_id_fkey
  FOREIGN KEY (module_id) REFERENCES course_modules (id) ON DELETE SET NULL;

ALTER TABLE lessons DROP CONSTRAINT IF EXISTS fk_lessons_org_module;
ALTER TABLE lessons ADD CONSTRAINT fk_lessons_org_module
  FOREIGN KEY (organization_id, module_id)
  REFERENCES course_modules (organization_id, id) ON DELETE SET NULL;

-- A lesson's course must be a real course in the same organization.
ALTER TABLE lessons DROP CONSTRAINT IF EXISTS fk_lessons_org_course;
ALTER TABLE lessons ADD CONSTRAINT fk_lessons_org_course
  FOREIGN KEY (organization_id, course_id)
  REFERENCES courses (organization_id, id) ON DELETE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. ASSESSMENTS ATTACH AT THREE LEVELS
-- ─────────────────────────────────────────────────────────────────────────
--
-- An assessment already belonged to a course. It can now be attached to one
-- LESSON, one MODULE, or the course as a whole (the final), or left staged
-- while its questions are written.
--
-- `link_type` is stored rather than derived from which id is set, because
-- 'course' and 'none' are BOTH "no module and no lesson" and they mean
-- opposite things — the final exam, and something not yet placed. A derived
-- flag could not tell them apart.
--
-- Existing rows become 'course': they were the course's only assessment and
-- that is exactly what a final is.

ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS link_type text NOT NULL DEFAULT 'course',
  ADD COLUMN IF NOT EXISTS module_id integer REFERENCES course_modules (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lesson_id integer REFERENCES lessons (id) ON DELETE SET NULL;

-- ON DELETE SET NULL above, plus this: deleting the module or lesson an
-- assessment was attached to must not delete the assessment and its
-- questions. It falls back to staged, and the admin re-attaches it.
UPDATE assessments SET link_type = 'none'
 WHERE link_type IN ('module', 'lesson')
   AND module_id IS NULL AND lesson_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_assessments_module ON assessments (module_id);
CREATE INDEX IF NOT EXISTS idx_assessments_lesson ON assessments (lesson_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. QUESTION TYPES
-- ─────────────────────────────────────────────────────────────────────────
--
-- Every existing question is multiple choice — that was the only kind the
-- builder could make — so the default backfills them correctly.
--
-- `correct_answer` holds the answer for the types that do not use the
-- `assessment_options` table: the expected text for fill-in-the-blank, and
-- the JSON pairs for matching. Multiple choice and multi-select keep using
-- options rows, because those need per-option ordering and an is_correct flag
-- that a single text column cannot carry.

ALTER TABLE assessment_questions
  ADD COLUMN IF NOT EXISTS question_type  text NOT NULL DEFAULT 'mcq',
  ADD COLUMN IF NOT EXISTS correct_answer text;

CREATE INDEX IF NOT EXISTS idx_assessment_questions_assessment
  ON assessment_questions (assessment_id, sort_order);
