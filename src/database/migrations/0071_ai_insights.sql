-- 0071_ai_insights.sql — storage for generated AI insights (spec ai-insights.md, Wave 1).
--
-- One latest insight per (organization, subject, kind): the nightly job and the
-- on-demand refresh both UPSERT here, and the UI reads it. ACTIVITY (orgScope) —
-- an insight about a learner or an org belongs to that one tenant.
--
-- The payload is the model's structured output as jsonb. It holds NO raw PII:
-- the feature layer that builds the prompt sends only aggregates and ids, and
-- the model is instructed to reference learners by id, so what comes back and is
-- stored here is advice, not personal data.

CREATE TABLE IF NOT EXISTS ai_insights (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  subject_type    text NOT NULL,
  subject_id      integer NOT NULL,
  kind            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  model           text NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ai_insights_subject_key
  ON ai_insights (organization_id, subject_type, subject_id, kind);
