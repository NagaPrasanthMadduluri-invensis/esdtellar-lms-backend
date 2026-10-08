-- 0046 - public UUIDs for the records whose ids appear in browser URLs
--
-- Sequential integer primary keys leak two things when they ride in a URL
-- (/my-courses/47, /scorm-player/30): roughly how many records exist, and a
-- guessable neighbour to probe. Authorization already closes the door on
-- reaching another tenant's row (every handler is org-scoped and ownership is
-- checked in the service, so a guessed id 404s), so this is enumeration
-- hardening rather than an open IDOR fix - but a public identifier should not
-- be guessable, and these ones are.
--
-- The fix is ADDITIVE, deliberately. The integer primary keys and every foreign
-- key stay exactly as they are - they are what joins and tenancy predicates run
-- on, and rewriting them would touch every table and every handler. Instead each
-- table whose id appears in a URL gains a second, non-sequential PUBLIC id. The
-- URL and the public API look a record up by this; the database still joins on
-- the integer underneath.
--
-- THREE-STEP, SAFE ROLLOUT (this file is step 1-2):
--   1. add the column NULLABLE, with a DEFAULT so every NEW row is born with one.
--   2. backfill every existing row (idempotent: only rows still NULL).
--   3. [a LATER migration, after the app reads/writes public_id everywhere]
--      SET NOT NULL. Deferred so this migration can never fail on a row the
--      app has not yet learned to populate, and so a rollback of the app code
--      does not strand a NOT NULL column it cannot fill.
--
-- gen_random_uuid() is core in PostgreSQL 13+ (prod is 18), so no extension is
-- needed. Every statement is idempotent - IF NOT EXISTS on the column and the
-- index, and the backfill only touches rows that are still NULL - so the boot
-- runner may re-apply it harmlessly.

-- courses  (/admin/courses/:id, /my-courses/:id)
ALTER TABLE courses ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE courses ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE courses SET public_id = gen_random_uuid() WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS courses_public_id_key ON courses (public_id);

-- lessons  (/my-courses/:courseId/lessons/:lessonId)
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE lessons ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE lessons SET public_id = gen_random_uuid() WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lessons_public_id_key ON lessons (public_id);

-- assessments  (/my-courses/:courseId/assessments/:assessmentId)
ALTER TABLE assessments ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE assessments ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE assessments SET public_id = gen_random_uuid() WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assessments_public_id_key ON assessments (public_id);

-- scorm_packages  (/scorm-player/:packageId)
ALTER TABLE scorm_packages ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE scorm_packages ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE scorm_packages SET public_id = gen_random_uuid() WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS scorm_packages_public_id_key ON scorm_packages (public_id);

-- sessions  (/trainer/sessions/:sessionId, and admin roster/attendance deep links)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE sessions ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE sessions SET public_id = gen_random_uuid() WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id_key ON sessions (public_id);

-- organizations  (/platform/organizations/:id)
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE organizations ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE organizations SET public_id = gen_random_uuid() WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS organizations_public_id_key ON organizations (public_id);

-- certificates  (/certifications?certificate=:id deep link; the verify CODE is
-- already non-sequential, this is for the learner's own in-app deep link)
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS public_id uuid;
ALTER TABLE certificates ALTER COLUMN public_id SET DEFAULT gen_random_uuid();
UPDATE certificates SET public_id = gen_random_uuid() WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS certificates_public_id_key ON certificates (public_id);
