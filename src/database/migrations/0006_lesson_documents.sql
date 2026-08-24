-- Documents as first-class lesson content, plus supporting resources.
--
-- Three things this adds:
--
-- 1. A lesson's primary content can now be a DOCUMENT (PDF, PPT, Word, ...),
--    either uploaded to R2 or pointed at by an external URL. A document has no
--    inherent runtime, so its `duration_minutes` is typed by the admin and is
--    mandatory — that number is what learning hours credits on completion.
--
-- 2. Any lesson can carry supporting resources alongside its primary content:
--    a video lesson with the slide deck and a handout attached, say. Each is
--    either an uploaded file or an external link. Resources are reference
--    material, so they carry no duration and never affect learning hours —
--    only the lesson's own duration does, and it is counted exactly once.
--
-- 3. SCORM packages record the runtime their manifest declares
--    (LOM typicalLearningTime), so the lesson duration can be prefilled from
--    the package instead of guessed. Null when the manifest does not say, which
--    is when the admin has to type it.
--
-- Learning hours are deliberately NOT changed by any of this (§10.4): video
-- still counts measured watch seconds, SCORM its own reported total_time, and
-- everything else — documents included — the declared duration on completion.

ALTER TABLE lessons ADD COLUMN IF NOT EXISTS document_key text;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS document_name text;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS document_mime text;
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS document_size_bytes integer;

ALTER TABLE scorm_packages ADD COLUMN IF NOT EXISTS duration_minutes integer;

-- `source` is what tells the two halves apart: an uploaded resource has
-- file_key and no url, a linked one has url and no file_key. Kept as an
-- explicit column rather than inferred from which field is null, so a row that
-- somehow has neither is visibly broken instead of silently a link.
CREATE TABLE IF NOT EXISTS lesson_resources (
  id serial PRIMARY KEY,
  lesson_id integer NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  title text NOT NULL,
  resource_type text NOT NULL DEFAULT 'other',
  source text NOT NULL,
  file_key text,
  file_name text,
  file_size_bytes integer,
  mime_type text,
  url text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Resources are always read for one lesson, in display order.
CREATE INDEX IF NOT EXISTS idx_lesson_resources_lesson
  ON lesson_resources (lesson_id, sort_order);
