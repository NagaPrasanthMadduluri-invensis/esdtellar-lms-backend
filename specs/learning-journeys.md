# Spec: Learning Journeys

> Owner decisions locked 2026-09-11. Four answers drive everything below; where a
> rule here looks arbitrary, it is one of those four.

## 1. Goal

A **learning journey** is an ordered path of existing courses that an admin
curates, assigns, and rewards. The learner works through it in sequence, sees
how far along they are, and on finishing the whole path earns three things at
once: a **standalone journey certificate**, a **badge**, and **bonus points**
on the one leaderboard everybody already reads.

It replaces `client/components/admin/admin-journeys-content.jsx`, which is
today a React `useState` mock with no table, no module and no API behind it.

## 2. Scope

**In scope**

- `journeys` + `journey_courses`: the curated, ordered path (admin-authored content).
- `journey_enrollments`: who is on a journey, and when they finished it.
- Sequential gating **inside a journey**, per §4.3.
- Assignment by user or department, which auto-assigns the member courses.
- Journey completion detection, reusing the existing completion triggers.
- A **standalone journey certificate**, verifiable on the same public page.
- A real `user_badges` table — journey badges, journey milestones, and the nine
  badges that exist today but are recomputed on every request and never stored.
- Journey bonus points **inside** the existing leaderboard formula.
- Admin CRUD UI, learner journey list + detail, Assign Learning "Journeys" tab.

**Out of scope**

- Streaks, daily goals, XP levels, or any second engagement currency.
- Journey-level assessments. A journey's assessment is whatever its courses carry.
- Nested journeys, prerequisites across journeys, or branching paths.
- Journey-level learning hours as a new figure — §7.4.
- Self-enrolment from a catalogue. Assignment is admin-driven (owner decision 4).

## 3. Data model

Migration **`0015_journeys.sql`** (additive, idempotent) plus one human-checkpoint
script for the non-additive certificate change (§3.4).

### 3.1 `journeys` — content (`contentScope`)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `organization_id` | integer NOT NULL | **Content**: owner org, or the platform org for a global journey |
| `title` | text NOT NULL | |
| `description` | text | capped at `DESCRIPTION_MAX_LENGTH` by the DTO |
| `tag` | text | e.g. "Sales · Role Path" — the mock's `tag` |
| `skills` | text | comma-separated, mirroring the mock's `skills[]` |
| `thumbnail_url` | text | same storage and rules as a course thumbnail (§10.10) |
| `badge_label` | text NOT NULL | what the earned badge is called |
| `badge_icon` | text NOT NULL DEFAULT `'award'` | a lucide icon name, from a closed list |
| `points_bonus` | integer NOT NULL DEFAULT 200 | added to the leaderboard on completion |
| `is_active` | integer NOT NULL DEFAULT 1 | draft vs published, exactly like `courses.is_active` |
| `created_at` / `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `idx_journeys_org_active (organization_id, is_active)`.

### 3.2 `journey_courses` — content (`contentScope` via its journey)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `organization_id` | integer NOT NULL | denormalised so the join can be scoped without reaching the journey |
| `journey_id` | integer NOT NULL | FK journeys, ON DELETE CASCADE |
| `course_id` | integer NOT NULL | FK courses, ON DELETE CASCADE |
| `sort_order` | integer NOT NULL DEFAULT 0 | **the sequence** |
| `is_required` | integer NOT NULL DEFAULT 1 | optional steps do not gate and do not block completion |

`UNIQUE(journey_id, course_id)` — a course appears at most once in a journey.
Index `idx_journey_courses_course (course_id)` for the reverse lookup.

### 3.3 `journey_enrollments` — activity (`orgScope`)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `organization_id` | integer NOT NULL | **Activity**: the learner's org |
| `journey_id` | integer NOT NULL | FK journeys, ON DELETE CASCADE |
| `user_id` | integer NOT NULL | FK users, ON DELETE CASCADE |
| `assigned_by` | integer | FK users |
| `assigned_at` | timestamptz NOT NULL DEFAULT now() | |
| `due_date` | text | nullable, same shape as `user_course_assignments.due_date` |
| `completed_at` | timestamptz | NULL until the whole path is done |

`UNIQUE(user_id, journey_id)`. Index `idx_je_org_user (organization_id, user_id)`.

**`completed_at` is the only stored progress.** Percentage, current step and
per-course status are all DERIVED from `user_lesson_completions` — §7.1.

### 3.4 `certificates` — journey certificates

Today: `course_id` NOT NULL, `UNIQUE(user_id, course_id)`, code `EDS-<courseId>-<userId>-<hash>`.
A journey certificate does not have a course. Three changes:

```
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS journey_id integer
  REFERENCES journeys(id) ON DELETE CASCADE;           -- additive, 0015
```

The other two are **non-additive and therefore a human checkpoint** —
`server/scripts/migrate-journey-certificates.mjs`, dry-run by default,
`--commit` to apply, matching `db:reset-to-admin`:

```
ALTER TABLE certificates ALTER COLUMN course_id DROP NOT NULL;
ALTER TABLE certificates DROP CONSTRAINT certificates_user_course_unique;
CREATE UNIQUE INDEX certificates_user_course_uniq
  ON certificates (user_id, course_id)  WHERE course_id  IS NOT NULL;
CREATE UNIQUE INDEX certificates_user_journey_uniq
  ON certificates (user_id, journey_id) WHERE journey_id IS NOT NULL;
CHECK ((course_id IS NULL) <> (journey_id IS NULL))    -- exactly one of the two
```

Journey certificate code: **`EDS-J<journeyId>-<userId>-<SHORTHASH>`**, same
hash construction as the course code. The `J` is what makes the two tellable
apart by eye in a support ticket.

### 3.5 `user_course_assignments` — one new column

```
ALTER TABLE user_course_assignments
  ADD COLUMN IF NOT EXISTS source_journey_id integer REFERENCES journeys(id) ON DELETE SET NULL;
```

**This column is what makes the owner's rule work.** NULL means the admin
assigned the course directly; a value means the row exists only because a
journey assigned it. §4.3 gates the second and never the first.

### 3.6 `user_badges` — activity (`orgScope`)

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `organization_id` | integer NOT NULL | **Activity**: the earner's org |
| `user_id` | integer NOT NULL | FK users, ON DELETE CASCADE |
| `badge_key` | text NOT NULL | from the catalogue in `common/badges.ts`, or `journey:<id>` |
| `journey_id` | integer | set for a journey badge, NULL otherwise; ON DELETE CASCADE |
| `earned_at` | timestamptz NOT NULL DEFAULT now() | |

`UNIQUE(user_id, badge_key)`. Index `idx_user_badges_org_user (organization_id, user_id)`.

**The badge catalogue is code, not data** — `server/src/common/badges.ts`,
following the `common/permissions.ts` precedent: a badge key means something
only because an award rule references it, so adding one is a reviewed code
change. Per-journey badges are the single exception and are keyed `journey:<id>`,
taking their label and icon from the journey row.

## 4. Rules

### 4.1 Completion

A journey is complete when **every `is_required` course in it is complete** for
that learner, by the definition that already exists — 100% of active lessons,
and any active assessment passed (`CertificatesService.evaluate`). There is no
second definition of "complete" and no new percentage maths.

### 4.2 When completion is detected

On the same three triggers `autoIssue` already uses — lesson complete,
assessment submitted, SCORM commit — and nowhere else. The new call is
`JourneysService.onCourseProgress(scope, userId, courseId)`, which:

1. finds the journeys that contain this course **and** that this learner is
   enrolled on and has not finished (one query);
2. for each, re-evaluates completion (one query per journey, not per course);
3. on newly complete: stamps `completed_at`, issues the journey certificate,
   awards the journey badge, re-checks milestone badges.

It is **best-effort and never throws into the caller** (§8.4) — a badge failure
must not break marking a lesson complete.

### 4.3 Sequential gating — the owner's rule, stated precisely

> A course is never locked globally. Only its position *inside a journey* is gated.

For a learner on journey J, course C at `sort_order = n`:

| Their assignment row for C | Gate |
|---|---|
| `source_journey_id IS NULL` (assigned directly) | **open** — always |
| `source_journey_id = J` | open only when every **required** course at `sort_order < n` in J is complete |
| no row | not assigned; not shown |

So an admin who assigns a mid-path course directly to somebody has opened it for
them, deliberately, and the journey view shows it as open. Assigning a journey
never overwrites an existing assignment row, so a direct assignment that already
exists keeps its `NULL` and stays open.

**The gate is advisory in the journey UI and enforced in the API**: the learner
lesson endpoints refuse a lesson whose course is journey-locked for that
learner, with 403 — otherwise the lock is a CSS rule anyone can walk around.

### 4.4 Points — one formula, extended

`POINTS_PER_JOURNEY` does not exist as a flat constant: each journey carries its
own `points_bonus`, because a 3-course path and a 12-course path are not worth
the same. The leaderboard's single query gains one subquery:

```sql
(SELECT COALESCE(SUM(j.points_bonus), 0)
   FROM journey_enrollments je
   JOIN journeys j ON j.id = je.journey_id
  WHERE je.user_id = u.id AND je.completed_at IS NOT NULL) AS journey_points
```

added into `points` in `LeaderboardRepository.standings()` — **the only place
points are summed** (§10.5). The month board adds the same term filtered on
`to_char(je.completed_at, 'YYYY-MM')`. No second calculation is created.

### 4.5 Badges — what is awarded

Persisted on award, never recomputed. Seeded catalogue:

- The **nine existing badges** (`first_steps`, `committed_learner`, `scholar`,
  `quick_learner`, `assessment_topper`, `perfectionist`, `high_flyer`,
  `learning_champion`, `feedback_hero`), moved from `learner.service.ts`'s
  derive-on-read into the catalogue and awarded on the same triggers. Their
  thresholds are stated **once** in `common/badges.ts`, not three times.
- **One badge per journey**, key `journey:<id>`.
- **Three journey milestones**: `journey_first` (finish any journey),
  `journey_three`, `journey_five`.

A backfill in the checkpoint script awards the nine existing badges to whoever
already qualifies, so nobody loses a badge they can see today.

## 5. API contract

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/api/admin/journeys` | admin | `?status`,`?limit`,`?offset` | `{ journeys: [...], total }` |
| POST | `/api/admin/journeys` | admin + `manage_journeys` | `JourneyDto` | `{ journey }` |
| GET | `/api/admin/journeys/:id` | admin | — | `{ journey }` incl. `courses[]` |
| PUT | `/api/admin/journeys/:id` | admin + `manage_journeys` | `JourneyDto` | `{ journey }` |
| DELETE | `/api/admin/journeys/:id` | admin + `manage_journeys` | — | `{ message }` |
| PUT | `/api/admin/journeys/:id/courses` | admin + `manage_journeys` | `{ courses: [{course_id, sort_order, is_required}] }` | `{ courses }` |
| GET | `/api/admin/journeys/:id/learners` | admin | `?limit`,`?offset` | `{ learners: [...], total }` — per-learner % and step |
| POST | `/api/admin/journeys/:id/assign` | admin + `assign_learning` | `{ user_ids[] }` or `{ department }` | `{ assigned, skipped }` |
| DELETE | `/api/admin/journeys/:id/assign/:userId` | admin + `assign_learning` | — | `{ message }` |
| GET | `/api/learner/journeys` | learner | — | `{ journeys: [...] }` with % and next step |
| GET | `/api/learner/journeys/:id` | learner | — | `{ journey }` with ordered `courses[]`, each `locked`/`open`/`complete` |
| GET | `/api/learner/badges` | learner | — | `{ badges: [...], next }` |

Existing endpoints that change shape (additively only): `GET /learner/certificates`
(rows may now carry `journey_name` instead of `course_name`), and the public
`GET /certificates/verify/:code` (returns `journeyName` for a `J` code).

## 6. Acceptance criteria

1. An admin creates a journey with a title, tag, description, thumbnail, badge
   label, points bonus, and an ordered list of ≥2 courses; it persists across a
   page reload.
2. Deleting a journey cascades its `journey_courses` and `journey_enrollments`
   and leaves the member **courses untouched**.
3. Assigning a journey to a department creates a `journey_enrollments` row and a
   `user_course_assignments` row per member course per learner, in **one
   set-based statement each** — no `await` inside a loop (§7.1).
4. Assigning a journey does **not** overwrite an existing direct assignment: a
   pre-existing row keeps `source_journey_id = NULL`.
5. A learner on a sequential journey sees step 1 open and steps 2..n locked;
   `GET /learner/lessons/:id` for a locked course returns **403**, not 200.
6. A course assigned directly is open for that learner even when it sits at
   step 3 of a journey they are on (owner's rule, §4.3).
7. Completing the last required course stamps `completed_at`, and without any
   manual step the learner sees: a journey certificate on `/certifications`, the
   journey badge on their achievements page, and their leaderboard points risen
   by exactly `points_bonus`.
8. The journey certificate verifies on the public page by its `EDS-J…` code and
   shows the **journey** name.
9. Revoking a journey certificate works from the admin certificates screen and
   the code then verifies as revoked.
10. A learner who has not finished a journey has no certificate, no badge and no
    bonus points for it.
11. Both leaderboards (learner and admin) show the same total, including journey
    points — no second calculation exists (§10.5).
12. Journey completion is idempotent: replaying the trigger awards one
    certificate, one badge and one lot of points.
13. Every list endpoint is paginated (§7.6); no endpoint runs a query per course.
14. A cross-tenant journey id returns 404, and an org admin gets 422 writing to a
    platform-owned journey.
15. `manage_journeys` exists in the catalogue **and** is enforced by a guard on
    every journey write route.

### 6a. End-to-end journeys (verified by driving the real UI)

- **Admin builds and assigns.** Admin → Learning Journeys → Create Journey → fills
  the form, adds 2 courses in order, uploads a thumbnail → Save → the card appears
  → Assign → picks a department → the learner count rises.
  *Trigger for `POST /admin/journeys`: the Create Journey dialog's Save button.
  For `/assign`: the Assign dialog in the journey card.*
- **Learner walks the path.** Learner → My Journeys → opens the journey → step 1
  open, step 2 shows a lock with "Complete X first" → finishes step 1 → step 2
  unlocks without a reload beyond navigating back.
  *Trigger for `GET /learner/journeys`: the My Journeys page mount.*
- **Learner finishes and is rewarded.** Completes the final lesson of the last
  course → returns to the journey → it reads 100% with a completion state →
  `/certifications` shows the journey certificate → achievements shows the badge →
  the leaderboard total has risen by `points_bonus`.
  *No new endpoint: the existing lesson-complete call fires `onCourseProgress`.*
- **Anyone verifies.** Copy the `EDS-J…` code → public verify page → valid, with
  the journey name and issue date, and no learner PII.

## 7. Notes for the builder

**7.1 Derive, do not store.** Only `completed_at` is written. Percentage and the
current step come from the same lesson-completion data the rest of the product
reads — §10.7's lesson ("a session is picked up by definitions that already
work") applies directly.

**7.2 No N+1.** A learner's journey list must evaluate every journey's progress
in ONE query using correlated subqueries, the way
`CertificatesRepository.getCompletionSnapshot()` collapsed 24 round trips to 1.

**7.3 Name collisions to resolve.** `LearnerService.dashboard().journey` and
`LearnerService.courses().journeyPct` already mean "all my assigned courses".
Rename those to `timeline` / `timelinePct` in the same change, and give the word
"journey" to this feature. The learner "Learning Journey" tab in
`my-courses-content.jsx` becomes "Timeline".

**7.4 Hours are unchanged.** A journey's hours are a sum over its member courses
using `minutesByUserAndCourse()`. Do not add a second place that sums hours (§10.4).

**7.5 Session trainings.** A journey may contain a session training. It is
completed for the learner by an admin, exactly as today; that is allowed to
advance a journey. But a journey certificate is still earned, not given — the
session exclusion in `autoIssue` is about a *course* certificate for turning up,
and a journey is a path of several courses.
