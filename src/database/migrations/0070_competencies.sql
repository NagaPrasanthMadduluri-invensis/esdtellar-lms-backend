-- 0070_competencies.sql — the competency foundation for AI Insights (spec ai-insights.md, Wave 0).
--
-- Three tables, additive and idempotent. No PII, no AI: this layer only records
-- which skills a course imparts and which a learner has gained by completing one,
-- so later waves can ground recommendations in what a person actually knows.
--
-- skills        CONTENT  (contentScope: platform-owned rows are shared; a tenant may add its own)
-- course_skills CONTENT  (a mapping on courses, which may be platform-owned)
-- user_skills   ACTIVITY (orgScope: always the learner's own organization)

-- The competency catalogue.
CREATE TABLE IF NOT EXISTS skills (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            text NOT NULL,
  slug            text NOT NULL,
  domain          text,
  is_active       integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One slug per organization: this is what lets "Project Management" typed twice
-- resolve to a single skill, and what the create path turns into a 409.
CREATE UNIQUE INDEX IF NOT EXISTS skills_organization_id_slug_key
  ON skills (organization_id, slug);

-- Which skills a course imparts, and at what level.
CREATE TABLE IF NOT EXISTS course_skills (
  id         serial PRIMARY KEY,
  course_id  integer NOT NULL REFERENCES courses (id) ON DELETE CASCADE,
  skill_id   integer NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  level      text NOT NULL DEFAULT 'intermediate',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS course_skills_course_id_skill_id_key
  ON course_skills (course_id, skill_id);

CREATE INDEX IF NOT EXISTS idx_course_skills_skill ON course_skills (skill_id);

-- Competencies gained, recorded against the learner on course completion.
CREATE TABLE IF NOT EXISTS user_skills (
  id                 serial PRIMARY KEY,
  organization_id    integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id            integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  skill_id           integer NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  level              text NOT NULL DEFAULT 'intermediate',
  source_course_id   integer REFERENCES courses (id) ON DELETE SET NULL,
  earned_at          timestamptz NOT NULL DEFAULT now(),
  last_reinforced_at timestamptz NOT NULL DEFAULT now()
);

-- One competency row per learner per skill. Completing another course that
-- imparts it reinforces (and may upgrade) the existing row rather than adding one.
CREATE UNIQUE INDEX IF NOT EXISTS user_skills_user_id_skill_id_key
  ON user_skills (user_id, skill_id);

CREATE INDEX IF NOT EXISTS idx_user_skills_org_user ON user_skills (organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_skills_skill ON user_skills (skill_id);

-- A shared starter catalogue, seeded into the PLATFORM organization only, so
-- every tenant sees it through contentScope without each having to type it.
-- Idempotent: re-running changes nothing, and an install with no platform org
-- yet seeds nothing (the next real boot after provisioning will).
INSERT INTO skills (organization_id, name, slug, domain)
SELECT o.id, v.name, v.slug, v.domain
FROM organizations o
CROSS JOIN (
  VALUES
    ('Leadership', 'leadership', 'Leadership'),
    ('People Management', 'people-management', 'Leadership'),
    ('Communication', 'communication', 'Interpersonal'),
    ('Collaboration', 'collaboration', 'Interpersonal'),
    ('Problem Solving', 'problem-solving', 'Cognitive'),
    ('Critical Thinking', 'critical-thinking', 'Cognitive'),
    ('Time Management', 'time-management', 'Productivity'),
    ('Project Management', 'project-management', 'Productivity'),
    ('Data Analysis', 'data-analysis', 'Technical'),
    ('Data Privacy', 'data-privacy', 'Compliance'),
    ('Information Security', 'information-security', 'Compliance'),
    ('Workplace Safety', 'workplace-safety', 'Compliance'),
    ('Customer Focus', 'customer-focus', 'Business'),
    ('Sales', 'sales', 'Business'),
    ('Negotiation', 'negotiation', 'Business'),
    ('Financial Literacy', 'financial-literacy', 'Business'),
    ('Software Development', 'software-development', 'Technical'),
    ('Cloud Computing', 'cloud-computing', 'Technical'),
    ('Product Management', 'product-management', 'Technical'),
    ('Change Management', 'change-management', 'Leadership')
) AS v (name, slug, domain)
WHERE o.is_platform = true
ON CONFLICT (organization_id, slug) DO NOTHING;
