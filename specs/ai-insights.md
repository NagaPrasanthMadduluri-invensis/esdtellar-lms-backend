# Spec: AI Insights & Competencies

> Program spec for the AI Insights module. Built in waves; each wave is verified
> before the next. If a decision contradicts `BACKEND_STRUCTURE.md`, update that
> first — then this spec.

> **Status (2026-11-20):** Waves 0 to 3 are built (BACKEND_STRUCTURE §10.53,
> §10.54, §10.56). The **nightly worker job** in §2 was never built: there is no
> AI job in `pg-boss.service.ts`, and insights are generated only on demand
> through the `POST .../ai/insights/refresh` routes. The Wave 0 UI follow-up in
> §5 has shipped (the course page's Skills tab; learner skills on the AI
> Insights page).

## 1. Goal

Make the LMS *intelligent*: an admin-facing layer that explains an organization's
learning patterns, milestones, course-flow health and negative-feedback hot
spots, and a learner-facing layer that recommends courses/assessments, nudges
pending feedback, and motivates with milestone and "finish by X → points →
badge" prompts. Recommendations are grounded in a new **competency** record —
the skills a learner has actually gained from completing courses — read together
with their role, history and position relative to the organization.

## 2. Scope

**In scope**
- **Competencies (Wave 0):** a `skills` catalogue, `course_skills` (what a course
  imparts), and `user_skills` (competencies recorded against the learner when a
  course completes). Admin CRUD for skills + course mapping; learner read of their
  own competencies. **No AI, no PII leaves the box** — this is pure data.
- **AI foundation (Wave 1):** an `AiModule` wrapping OpenRouter
  (`deepseek/deepseek-v4-pro` default), **off by default**, never throwing into a
  request; a **feature layer** that assembles a minimized, PII-light context from
  existing repositories; an `ai_insights` store; a nightly worker job (not built,
  see Status).
- **Learner vertical (Wave 2):** per-learner recommendations, nudges, milestone
  notifications, motivational prompts; a dashboard panel + on-demand refresh.
- **Admin vertical (Wave 3):** org learning-pattern insights, milestones &
  improvements, course-flow analysis, negative-feedback handling.

**Out of scope**
- Giving the model raw database/table/row access or any RAG over live PII.
- Any auto-action taken on the model's output (it only *suggests*; a human or an
  existing deterministic flow acts). The model never sends email, never assigns a
  course, never changes a setting.
- Chatbot / free-form Q&A UI (a later consideration).

## 3. Data model

### Wave 0 — `0070_competencies.sql` (additive, idempotent)

**`skills`** — the competency catalogue. CONTENT (`contentScope`): platform-owned
rows are a shared starter set; a tenant may add its own (private to it).
- `id` serial PK · `organization_id` int NOT NULL → organizations (owner) ·
  `name` text NOT NULL · `slug` text NOT NULL · `domain` text NULL ·
  `is_active` int NOT NULL default 1 · `created_at` · `updated_at`
- `UNIQUE (organization_id, slug)`
- Seeds a starter set into the platform org (idempotent `ON CONFLICT DO NOTHING`).

**`course_skills`** — which skills a course imparts, at what level.
- `id` serial PK · `course_id` int NOT NULL → courses (cascade) ·
  `skill_id` int NOT NULL → skills (cascade) ·
  `level` text NOT NULL default 'intermediate' (beginner|intermediate|advanced) ·
  `created_at`
- `UNIQUE (course_id, skill_id)` · index on `skill_id`

**`user_skills`** — competencies gained, recorded against the learner. ACTIVITY
(`orgScope`): always the learner's own org.
- `id` serial PK · `organization_id` int NOT NULL → organizations ·
  `user_id` int NOT NULL → users (cascade) · `skill_id` int NOT NULL → skills
  (cascade) · `level` text NOT NULL (highest attained) ·
  `source_course_id` int NULL → courses (set null) · `earned_at` ·
  `last_reinforced_at`
- `UNIQUE (user_id, skill_id)` · index `(organization_id, user_id)` · index `skill_id`

Recording: `CompetenciesService.onCourseCompleted(scope, userId, courseId)` is
called best-effort at the three completion seams (scorm, assessments, learner),
re-derives completion through the ONE definition
(`CertificatesService.isCourseComplete`, which wraps `getCompletionSnapshot` +
`evaluate`), and upserts `user_skills` from the course's `course_skills` —
**upgrading** `level`, never downgrading.

> ⚠️ Schema/migration change — **human checkpoint**.

### Wave 1 (later)
`ai_insights` (subject_type learner|org, subject_id, kind, payload jsonb, model,
generated_at, org-scoped) + env vars (§9). No PII columns.

## 4. API contract

### Wave 0
| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/admin/skills` | admin · `manage_courses` | `?archived=` | `{ skills: [...] }` |
| POST | `/api/admin/skills` | admin · `manage_courses` | `{ name, domain? }` | `{ skill }` (201) |
| PATCH | `/api/admin/skills/:id` | admin · `manage_courses` | `{ name?, domain?, isActive? }` | `{ skill }` |
| GET | `/api/admin/skills/course/:courseId` | admin · `manage_courses` | — | `{ skills: [{skillId, name, level}] }` |
| PUT | `/api/admin/skills/course/:courseId` | admin · `manage_courses` | `{ skills: [{skillId, level}] }` | `{ ok, count }` |
| GET | `/api/learner/competencies` | learner | — | `{ competencies: [{skill, level, earnedAt, sourceCourse}] }` |

No new permission (reuses `manage_courses`), so no `perm_version` bump.

## 5. UI
Wave 0 ships no new page. Course→skill tagging is added to the course-authoring
screen in a small follow-up; the learner competency panel ships with Wave 2.

## 6. Acceptance criteria
1. Migration 0070 applies idempotently and seeds the starter skills into the
   platform org only.
2. Completing a course that has `course_skills` records a `user_skills` row per
   skill for that learner, in their own org; an incomplete course records nothing.
3. Completing a second course that imparts the same skill at a higher level
   upgrades `level`; a lower level never downgrades it.
4. Recording is idempotent (replaying completion changes nothing but
   `last_reinforced_at`) and best-effort (a failure never breaks lesson/assessment
   completion).
5. Admin skill CRUD is tenant-isolated: a tenant sees its own + platform skills,
   never another tenant's; duplicate slug → 409; cross-tenant id → 404.
6. `user_skills` counts are `orgScope`d; `course_skills` course counts are
   `contentScope`d (no cross-tenant leak, §10.12).

### 6a. End-to-end journeys
- **(Wave 0, API-verifiable)** Admin maps skills to a course → a learner completes
  that course → `GET /api/learner/competencies` shows the gained skills with level
  and source course. (UI trigger for the mapping arrives with the authoring-screen
  follow-up.)

## 7. Human checkpoints
- Migration 0070 (schema).
- **Wave 1: the data-to-AI boundary.** The feature layer's output is the exact
  set of fields that leave the box to OpenRouter; it must be reviewed as a PII
  surface before the AI is ever enabled. No names, emails, DM/free-text content.
- Enabling the AI in production (feature flag) is a deliberate, owner-approved act.

## 8. Non-goals / risks
- Level is a coarse 3-step signal, not a rubric.
- The AI never gets raw rows; "access the whole database" is satisfied by the
  feature layer reading it and sending aggregates.
- Token cost is bounded by batch generation + caps (Wave 1). As built, the bound
  is on-demand refresh only, rate-limited (no batch job exists).
