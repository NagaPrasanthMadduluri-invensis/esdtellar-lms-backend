# Spec: Multi-Tenancy (Organizations)

> Phase 1 of a three-phase programme. This spec covers **tenancy only**.
> RBAC ("other roles") is deliberately deferred — see §2 and §8.
> Schema changes here are a **human checkpoint**; nothing in §3 auto-merges.

---

## 1. Goal

Turn the single-organization LMS into a multi-organization platform served from
**one PostgreSQL database**. Each organization gets its own admins, learners,
courses, sessions, SCORM packages and certificates, fully isolated from every
other organization. A **platform administrator** operates above all
organizations: onboarding them, publishing a shared course catalogue, and
reading cross-organization statistics.

Tenancy is a **column**, not a server. There is no database, schema, or
connection pool per organization. `DATABASE_URL` is unchanged, and the AWS RDS
deployment is unaffected.

---

## 2. Scope

**In scope**
- `organizations` table, including one reserved **platform organization**.
- `organization_id` on all 21 existing tables.
- Composite foreign keys binding every activity row to a user in the same org.
- `organizationId` claim in the JWT; `TenantContextGuard`; branded `OrgScope`.
- Threading `OrgScope` through all 12 repositories (~40 query roots).
- Global (platform-owned) vs organization-private **courses and SCORM packages**.
- `modules/platform/` — org CRUD, global catalogue, cross-org analytics.
- `client/app/(platform)/` route group with its own layout and sidebar.
- Authenticating SCORM static content (§3.9) and prefixing storage keys per org.
- Cross-tenant isolation test harness (the one testing exception — see §7).

**Out of scope**
- **RBAC / custom roles.** `users.role` stays the two-value enum
  `admin | learner`. It is the *portal selector*, nothing more. Granular
  permissions arrive in phase 3 as a `permissions[]` JWT claim and do not
  change anything in this spec.
- Row-Level Security. Phase 2 — it needs request-scoped connections, which do
  not exist today (see §8).
- Per-organization theming. The palette in `TASTE.md` §10 stays closed;
  organizations carry a name and logo only.
- Selective course sharing ("this course for orgs 1, 3 and 7"). Two tiers only:
  platform-global or org-private. §3.4 keeps the door open.
- Self-service organization signup. Platform admins onboard orgs by hand.

---

## 3. Data model

### 3.1 Decisions locked with the product owner

| # | Decision | Consequence |
|---|---|---|
| 1 | **One email = one organization.** `users.email` stays globally `UNIQUE`. | Login is completely unchanged. No org picker, no subdomain, no enumeration oracle. |
| 2 | **Courses may be global or org-private.** | Encoded with a platform-org sentinel — §3.4. |
| 3 | **Tenancy first, RBAC later.** | `role` enum untouched; guards gain an org dimension only. |

### 3.2 New table

```sql
CREATE TABLE IF NOT EXISTS organizations (
  id          serial PRIMARY KEY,
  name        text        NOT NULL,
  slug        text        NOT NULL UNIQUE,      -- URL-safe; subdomains later
  logo_url    text,
  is_platform boolean     NOT NULL DEFAULT false,
  is_active   integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Exactly one platform organization can ever exist.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_one_platform
  ON organizations (is_platform) WHERE is_platform;
```

The platform org id is **looked up once at boot** and injected as a provider.
It is never a hard-coded literal in a query.

### 3.3 The org column rule

Every tenant-owned table gets `organization_id integer NOT NULL`. Which org it
carries follows one rule, and the rule is what keeps the model coherent:

| Table group | Tables | Carries the org of |
|---|---|---|
| **Identity** | `users` | itself |
| **Activity** | `user_course_assignments`, `user_lesson_completions`, `user_assessment_attempts`, `user_assessment_answers`, `certificates`, `user_scorm_assignments`, `scorm_tracking`, `scorm_attempts`, `lesson_video_progress`, `session_roster`, `session_attendance` | **the user** |
| **Content** | `courses`, `course_modules`, `lessons`, `lesson_resources`, `assessments`, `assessment_questions`, `assessment_options`, `scorm_packages` | **the owner** (a real org, or the platform org) |
| **Sessions** | `sessions` | always a real org — **never** the platform org |

> A learner in Acme completing a lesson of a *global* course produces a
> completion row tagged **Acme**, not platform. Activity is always the
> learner's. This is what keeps every existing per-learner query correct.

**One exception.** `user_assessment_answers` has **no `user_id` column** — only
`attempt_id`, `question_id`, `selected_option_id`
(`0000_baseline_schema.sql:131`). It still carries the learner's org, but it
reaches it through its attempt: its composite FK binds to
`user_assessment_attempts (organization_id, id)`, not to `users`, and its
backfill joins through `attempt_id`.

### 3.4 Global vs private content — the platform-org sentinel

Two kinds of content may be global: **courses** and **SCORM packages**. Both
follow the identical rule — a global one is owned by the **platform
organization**, never by `NULL`.

```sql
-- catalogue read (admin Content Library, Assign Learning)
WHERE c.organization_id IN (:orgId, :platformOrgId) AND c.is_active = 1
```

Measured on a 6,000-course catalogue (1,200 global + 400 private × 12 orgs),
returning 1,600 rows:

| Encoding | Time |
|---|---|
| `organization_id = :org` (private only, baseline) | 0.82 ms |
| `organization_id = :org OR organization_id IS NULL` | 4.52 ms |
| **`organization_id IN (:org, :platform)`** | **4.32 ms** |

The two global encodings are indistinguishable on speed. The sentinel wins on
**integrity**: it keeps `organization_id NOT NULL` on every table, which is what
lets the composite foreign keys in §3.5 exist at all. `NULL` would forfeit them.

**Rules for global content** (courses and SCORM packages alike)
- Only a platform admin may create, edit, or delete one.
- Org admins see them badged **Global**, read-only, and may assign them.
  `CoursesService` / `ScormService` throw **422** on any write — the same
  refusal `CoursesService` already gives for session trainings.
- A global item that is a draft (`is_active = 0`) is invisible to orgs.
- Sessions are never global; a session's companion course inherits the
  session's org.

**SCORM specifics.** `scorm_packages.organization_id` carries the *owner* —
the platform org for a global package, a real org for a private one. The
learner-side rows follow the activity rule and carry the **learner's** org:
`user_scorm_assignments`, `scorm_tracking`, `scorm_attempts`. So a learner in
Acme taking a global package produces Acme-tagged tracking, and Acme's learning
hours and leaderboard pick it up with no new code path — exactly how global
courses behave.

A SCORM package embedded in a lesson must satisfy:
`package.organization_id IN (lesson.organization_id, platformOrgId)`. A private
package from another org can never be embedded. Enforced in `ScormService`,
not by FK (§3.5 — SQL cannot express "mine or platform").

### 3.5 Composite foreign keys — the structural guarantee

Parents expose a composite target; activity children bind to it:

```sql
ALTER TABLE users
  ADD CONSTRAINT users_org_id_key UNIQUE (organization_id, id);

ALTER TABLE user_lesson_completions
  ADD CONSTRAINT ulc_user_same_org
  FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)
  ON DELETE CASCADE;
```

Verified against PostgreSQL 14:

```
INSERT INTO completions (user_id, lesson_id, organization_id) VALUES (20, 555, 2);
ERROR:  insert or update on table "completions" violates foreign key constraint "same_org"
DETAIL:  Key (organization_id, user_id)=(2, 20) is not present in table "u".
```

An activity row pointing at a user in another organization is **rejected by the
database**. Not by a reviewer, not by a `WHERE` clause.

**Where the guarantee stops — stated honestly.** SQL cannot express "the lesson
belongs to my org *or* to the platform." So the link from an activity row to a
*content* row (`completion → lesson`) is **not** FK-enforced. It is enforced in
the service via the assignment check, consistent with `BACKEND_STRUCTURE.md`
§5.3 (ownership is checked in the service), and backstopped by RLS in phase 2.

> **The user axis is database-enforced. The content axis is service-enforced.**
> Do not describe this design as "the database prevents all cross-tenant data".

Applies to the whole content tree too: `lessons(organization_id, module_id)` →
`course_modules(organization_id, id)`, and so on up to `courses`.

### 3.6 Constraints that do NOT change

Worth stating, because the instinct is to widen all of them:

| Constraint | Change? | Why |
|---|---|---|
| `UNIQUE(user_id, course_id)` | **No** | `user_id` already determines the org via §3.5 |
| `UNIQUE(user_id, lesson_id)` | No | Same |
| `UNIQUE(session_id, user_id)` | No | Same |
| `UNIQUE(user_id, package_id)` | No | Same |
| `users.email UNIQUE` | **No** | Decision 1 |
| `certificates.certificate_code UNIQUE` | **No — must stay global** | Public verify is cross-tenant by design |
| `scorm_packages.package_dir UNIQUE` | No | UUID |
| `courses_session_unique` | No | |

### 3.7 Indexes

Every index on a filtered column gains `organization_id` as its **leading**
column. This is not overhead — it is the most selective predicate available and
makes per-org reads faster than the equivalent single-tenant query.

```sql
CREATE INDEX IF NOT EXISTS idx_users_org_role_active
  ON users (organization_id, role, is_active);          -- replaces idx_users_role_active
CREATE INDEX IF NOT EXISTS idx_ulc_org_user  ON user_lesson_completions (organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_uaa_org_user  ON user_assessment_attempts (organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_uca_org_user  ON user_course_assignments (organization_id, user_id);
CREATE INDEX IF NOT EXISTS idx_courses_org_active ON courses (organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_sessions_org_date  ON sessions (organization_id, date);
CREATE INDEX IF NOT EXISTS idx_certs_org_user     ON certificates (organization_id, user_id);
```

Drop the single-column predecessors only where the composite serves the same
leftmost prefix (`BACKEND_STRUCTURE.md` §6.3).

### 3.8 Performance budget (measured, not estimated)

Benchmarked on PostgreSQL 14 with the real `AnalyticsRepository.learnerStats()`
query shape and the live data's ratios (23 completions / 4 assignments /
3 attempts per learner). Target scenario: **org A = 500 learners + 2 admins,
org B = 200 learners + 2 admins.**

| Scenario | Learners scanned | Execution |
|---|---|---|
| Today, live DB | 18 | 1.7 ms |
| 2 orgs (700 users), unscoped, current indexes | 704 | 41 ms |
| **2 orgs, org-scoped + composite indexes → org A** | 500 | **29 ms** |
| 12 orgs (7,704 users), **unscoped** | 7,704 | 851 ms |
| **12 orgs, org-scoped → org A** | 500 | **55 ms** |
| **12 orgs, org-scoped → org B** | 200 | **12 ms** |
| Cross-org rollup, one `GROUP BY organization_id` | 177k rows | 36 ms |
| *Same query with no indexes at all* | 704 | *1,959 ms* |

Two conclusions that drive the design:

1. **Scoping makes it faster, not slower** — 29 ms scoped vs 41 ms unscoped at
   the same data size.
2. **A scoped query is bounded by the org's size; an unscoped one by the
   platform's.** From 2 → 12 orgs: scoped 29 → 55 ms, unscoped 41 → 851 ms. A
   missing `WHERE organization_id` is not only a leak, it is the 851 ms row.

Regression gate: **any org-scoped admin endpoint exceeding 150 ms at 500
learners is a defect.** Add ~1–3 ms per query for the RDS network hop.

### 3.9 Serving SCORM content — authenticated, without an N+1

**Verified live on 2026-08-31**: a file placed in the storage root was returned
`HTTP 200` with its contents to a request carrying **no cookie at all**, both
from the API directly and through the client proxy. `useStaticAssets` in
`main.ts` mounts outside the Nest guard chain, so `AuthGuard` never sees these
requests. Today that exposes every package to anyone holding a UUID. Once a
second organization exists it is a cross-org content leak, and it must be closed
**before** org #2 is onboarded.

**The cookie already arrives.** The client rewrite forwards request headers, and
cookies ignore ports — `lms_token` set for `localhost` reaches `:3000` as well
as `:3001`, which is exactly why `lib/session.js` can read it. So no new
credential mechanism is needed; the token is present and simply unchecked.

**The trap: one SCORM page load pulls 50–200 assets.** A naive entitlement query
per asset is 200 round trips per launch — a textbook violation of §7.1. The fix
must authenticate every asset while querying roughly once.

**Design.** Replace `useStaticAssets` with an Express middleware mounted at
`/scorm` **before** static serving:

1. Verify `lms_token` with `TokenService` — HMAC only, **zero** database work.
2. Resolve `packageDir` from the first path segment.
3. Check entitlement against an in-process LRU keyed `(userId, packageDir)`,
   TTL 60 s. On a miss, **one** query resolves package org + assignment:

```sql
-- A learner reaches a package two ways. Both must be honoured, or every
-- course-embedded SCORM lesson 404s. This mirrors ScormRepository.hasAccess,
-- re-keyed on package_dir because that is what the URL carries.
SELECT 1 AS ok
FROM scorm_packages p
JOIN user_scorm_assignments a ON a.package_id = p.id AND a.user_id = :userId
WHERE p.package_dir = :packageDir AND p.is_active = 1
  AND p.organization_id IN (:orgId, :platformOrgId)     -- org predicate: phase 5
UNION
SELECT 1 AS ok
FROM scorm_packages p
JOIN lessons l                  ON l.scorm_package_id = p.id
JOIN course_modules cm          ON cm.id = l.module_id
JOIN user_course_assignments uca ON uca.course_id = cm.course_id
WHERE p.package_dir = :packageDir AND p.is_active = 1
  AND uca.user_id = :userId
  AND p.organization_id IN (:orgId, :platformOrgId)
LIMIT 1
```

> **Corrected 31 Aug 2026.** An earlier draft of this section checked
> `user_scorm_assignments` alone. `client/components/learner/lesson-content.jsx`
> launches the player from a lesson, so that shape would have 404'd every
> course-embedded package. The org predicate is added in phase 5, when
> `OrgScope` and the platform-org provider exist; phases 2-3 ship the UNION
> without it.

**Admins may preview.** `role === 'admin'` is entitled to any active package in
`(own org, platform org)` without an assignment. No admin surface links to the
player today, so a learner-only rule would ship correct and silently foreclose
admin preview.

4. Miss → **404** (never 403 — a 403 confirms the package exists).

First asset costs one query; the remaining 199 are served from memory. The 60 s
TTL means a revoked assignment keeps working for up to a minute — acceptable for
content bytes, and it must be written down rather than discovered.

**401 inside an iframe must render HTML**, not a JSON envelope. An expired
session should show "Your session expired — reload to continue", not raw JSON in
the player frame.

`/scorm` stays excluded from the client middleware matcher (`TASTE.md` §4.3).
It was never the security boundary; the API is.

**Storage layout.** `storage/scorm/<owningOrgId>/<uuid>/`, and R2
`org/<owningOrgId>/...`. `package_dir` keeps holding the bare UUID and stays
globally `UNIQUE`; `ScormStorageService.directoryFor(orgId, packageDir)`
composes the path. The change is confined to that one service, which is
precisely what it exists for.

**Orphan cleanup.** The storage root currently holds 3 extracted directories
against 0 `scorm_packages` rows — leftovers from a database reset, since neither
`db:seed` nor `db:reset-to-admin` touches storage (§10.6). Migrating to per-org
directories needs a reconciliation script that reports orphans rather than
deleting them silently.

### 3.10 Migration sequence

`DatabaseService.onModuleInit()` runs everything in `migrations/` on boot, so
the non-additive work must **not** live there (`BACKEND_STRUCTURE.md` §6.2).

**`0007_organizations.sql`** — additive, safe for the boot runner:
`CREATE TABLE organizations`; add every `organization_id` column **nullable**;
create the new indexes. On PG 11+ `ADD COLUMN` without a volatile default is
metadata-only, so this does not rewrite tables.

**`scripts/migrate-tenancy.mjs`** — a deliberate, reviewed run
(`npm run db:migrate:tenancy`), never automatic:
1. Insert the platform organization (`is_platform = true`).
2. Insert the first real organization from `ORG_NAME`.
3. Backfill every table with set-based `UPDATE`s — no loops.
4. `SET NOT NULL` on every `organization_id`.
5. Add the `UNIQUE (organization_id, id)` parents and the composite FKs.
6. Drop superseded single-column indexes.
7. Verify: zero NULL org ids, zero orphans, row counts unchanged. Abort on any
   failure — the whole script is one transaction.

Existing data (18 users, 10 courses, 412 completions) becomes the **first real
organization**. The platform org starts empty; global courses are promoted into
it afterwards, by hand.

---

## 4. API contract

### 4.1 Enforcement

`organizationId` becomes a signed JWT claim. `TokenService`'s wire format is
now free to change — §10 of `BACKEND_STRUCTURE.md` records the Next.js
migration as complete, so the legacy verifier that locked it is gone.

> **Deploy note:** existing 7-day tokens carry no `organizationId`. A token
> without the claim is **invalid**, so deploying signs everyone out once. This
> is intentional — the alternative is a token that defaults to some org.

```ts
/** A verified tenant scope. Only TenantContextGuard can mint one. */
export type OrgScope = { readonly organizationId: number; readonly __brand: unique symbol };
```

- Scope is a **required positional parameter** on every repository method that
  touches a tenant-owned table. Omission is a **compile error**, not a review
  miss.
- One shared `orgScope(alias, scope)` SQL fragment emits the predicate — the
  same single-definition idiom as `lessonSource` in
  `learning-hours.repository.ts`.
- It is minted **only** from the verified JWT. Never a body, query param, or
  header — the rule `BACKEND_STRUCTURE.md` §5.3 already applies to roles.

### 4.2 Platform admin

**Platform admins are ordinary `users` rows in the platform organization with
`role = 'admin'`.** No second users table, no second login endpoint, no
duplicated scrypt logic — `POST /api/auth/login` and `GET /api/auth/me` are
untouched, and `organization_id` stays `NOT NULL`.

```ts
@PlatformAdmin()   // role === 'admin' AND organizationId === platformOrgId
```

Because an org admin can only create users within their own `OrgScope`, no org
admin can mint a platform admin.

### 4.3 New endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/api/platform/organizations` | platform | `{ organizations: [...] }` |
| POST | `/api/platform/organizations` | platform | `{ organization }` |
| GET | `/api/platform/organizations/:id` | platform | `{ organization, stats }` |
| PATCH | `/api/platform/organizations/:id` | platform | `{ organization }` |
| POST | `/api/platform/organizations/:id/admins` | platform | `{ user }` — seeds the first org admin |
| GET | `/api/platform/analytics` | platform | `{ byOrganization: [...], totals }` |
| GET | `/api/platform/courses` | platform | global catalogue CRUD |
| POST/PUT/DELETE | `/api/platform/courses/:id` | platform | global courses only |
| GET | `/api/platform/scorm` | platform | global SCORM library |
| POST | `/api/platform/scorm/upload` | platform | uploads a global package |
| DELETE | `/api/platform/scorm/:id` | platform | global packages only |

Cross-org reads live in **`platform-analytics.repository.ts` — the only
repository permitted to omit `orgScope`**, written as set-based
`GROUP BY organization_id` aggregates (36 ms measured). A grep for repositories
without `orgScope` must return exactly that one file; that grep *is* the audit.

Never reuse the per-learner correlated-subquery shape across orgs — that is the
851 ms row. Defer materialized rollups until well past a dozen organizations.

### 4.4 Existing endpoints

All 105 keep their paths and response shapes. Every one becomes org-scoped.
Cross-org access returns **404**, not 403 — a 403 would confirm the resource
exists in another org.

`GET /api/certificates/verify/:code` stays `@Public()` and cross-tenant, and
still returns no PII and no organization name.

---

## 5. UI

**New route group** `client/app/(platform)/platform/*` with its own
`layout.js` and sidebar (`TASTE.md` §1.1 — never a conditional inside the admin
shell):

| Route | Feature |
|---|---|
| `/platform/dashboard` | Cross-org KPIs, per-org comparison |
| `/platform/organizations` | List, create, activate/deactivate |
| `/platform/organizations/[id]` | Detail, stats, seed first admin |
| `/platform/catalog` | Global course CRUD |
| `/platform/scorm` | Global SCORM library — upload, stats, delete |

**Changes to existing UI**
- `lib/session.js` returns `organizationId`, `organizationName`, `isPlatformAdmin`.
- `app/page.js` entry redirect gains a platform branch.
- `(admin)` and `(learner)` layouts redirect a platform admin to `/platform/dashboard`.
- `middleware.js` unchanged — still cookie-presence only.
- Top nav shows the organization name. Palette unchanged (`TASTE.md` §10).
- Content Library badges global courses and disables their edit controls.

---

## 6. Acceptance criteria (grading rubric)

1. One database, one pool, one `DATABASE_URL`. No per-org connection logic.
2. `organizations` exists with exactly one `is_platform` row, enforced by a partial unique index.
3. All 21 tables carry `organization_id NOT NULL`.
4. Composite FKs exist on every activity table; a cross-tenant insert is rejected by Postgres.
5. Every repository method touching a tenant-owned table takes `OrgScope` as a required parameter; removing it fails `npm run build`.
6. Every repository either calls `orgScope(...)` or takes a `scope: OrgScope`
    parameter. Check with
    `for f in src/modules/*/*.repository.ts; do grep -qE 'orgScope\(|scope: OrgScope' $f || echo $f; done`
    — a plain `grep -L orgScope` is not enough, because a repository that is
    deliberately unscoped documents that fact in a comment and would match.
    The check returns exactly three files, each unscoped for a stated reason:
    - `auth.repository.ts` — login resolves a globally-unique email **before**
      any scope exists (decision 1 makes this correct, not an oversight).
    - `organizations.repository.ts` — resolves the platform org id at boot,
      which is inherently cross-org and precedes any request.
    - `platform-analytics.repository.ts` — cross-org aggregates by design
      (phase 6; does not exist yet).

    A fourth file in that list is a defect. Note also that
    `users.repository.emailExists` is deliberately unscoped *within* a scoped
    repository: `users.email` is globally unique, so an address taken in
    another organization is still unavailable, and scoping the check would turn
    a clean 409 into a 500 from the database constraint.
7. `organizationId` is a signed JWT claim; a token lacking it is rejected.
8. Global courses are owned by the platform org. Org admins can assign but not edit them (422).
9. Catalogue reads use `IN (:org, :platform)`; no `OR ... IS NULL` in any course query.
10. Org-scoped admin endpoints stay under 150 ms at 500 learners (§3.8).
11. Cross-org resource access returns 404, never 403 or data.
12. SCORM content is no longer served unauthenticated, verified by curl with
    no cookie. An anonymous or invalid-token request returns **401** with an
    HTML body (§3.9 — it renders inside the player iframe); an authenticated
    caller with no entitlement returns **404**. The 401 is decided before any
    package lookup and is byte-identical for real and fabricated UUIDs, so it
    is not an existence oracle — 404 is reserved for the entitlement miss,
    where distinguishing it from 403 does matter.
13. A learner entitled to a package loads it, and the whole launch costs **one**
    entitlement query regardless of asset count (verify in the query log).
14. SCORM packages honour the same global/private rule as courses: an org admin
    can assign a platform package but gets **422** editing or deleting it.
15. A private package from org A is invisible to org B and cannot be embedded in
    org B's lesson.
16. `GET /api/certificates/verify/:code` still works cross-tenant with no PII.
17. `role` is still exactly `admin | learner`. No RBAC leaked into this phase.

### 6a. End-to-end user journeys (MANDATORY)

Drive the real UI. Per `verify-user-journey-not-api`, curl does not count.

- **Onboarding.** As a platform admin I create org "Globex" at
  `/platform/organizations` → seed its first admin → log in as that admin →
  `/admin/dashboard` shows zero learners and zero courses, and none of Acme's data.
- **Isolation (the critical one).** Log in as Acme's admin, note a learner id
  from `/admin/users`. Log in as Globex's admin and visit
  `/admin/users/<that id>` → **404**. Repeat for a course, a session, a
  certificate and a SCORM package.
- **Global catalogue.** Platform admin publishes "Workplace Safety" at
  `/platform/catalog` → both org admins see it in their Content Library badged
  Global with edit disabled → each assigns it → a learner in each org completes
  it → each certificate carries its own org, and neither org's reports show the
  other's learners.
- **Private course.** Acme's admin creates a course → it does **not** appear in
  Globex's Content Library or Assign Learning.
- **Cross-org stats.** Platform admin opens `/platform/dashboard` → per-org
  learner counts, completions and hours, matching what each org admin sees in
  their own dashboard.
- **Session tenancy.** Acme's admin creates a session, adds a roster, marks
  attendance → the companion course, assignment and completion all carry Acme's
  org, and Globex's leaderboard is unchanged.
- **Global SCORM.** Platform admin uploads a package at `/platform/scorm` →
  both org admins see it badged Global and assign it → a learner in each org
  launches the player, and progress saves against their own org → signing out
  and re-fetching an asset URL directly returns 404.
- **Private SCORM.** Acme's admin uploads a package → it does not appear in
  Globex's SCORM library, and Globex cannot embed it in a lesson.
- **Public verification.** A certificate code from Acme verifies at
  `/verify/<code>` while signed out, revealing course name and validity only.

---

## 7. Human checkpoints (do NOT auto-merge)

1. **`0007_organizations.sql` and `scripts/migrate-tenancy.mjs`.** Non-additive:
   `SET NOT NULL`, composite FKs, dropped indexes. Review and run deliberately.
2. **Backfill correctness.** Every existing row lands in the first real org.
   Verify counts before and after; the script aborts on mismatch.
3. **Token invalidation.** Deploying signs every user out (§4.1). Schedule it.
4. **SCORM static serving is currently unauthenticated.**
   `app.useStaticAssets(..., { prefix: '/scorm' })` in `main.ts` runs *outside*
   the Nest guard chain, and `/scorm` is excluded from the client middleware
   matcher. Today anyone with a package UUID reads the files. Single-tenant that
   is a shrug; multi-tenant it is a cross-org content leak. **This must be fixed
   before organization #2 is onboarded**, via authenticated streaming or signed
   URLs.
5. **Storage keys must gain org prefixes** — `storage/scorm/<orgId>/<uuid>/`,
   R2 `org/<orgId>/lessons/...`. Without them an org's data cannot be deleted,
   metered, or exported on offboarding. Moving the 3 existing directories needs
   a reconciliation script that **reports** orphans rather than deleting them.
6. **Testing exception.** `AGENTS.md` records no test harness, and that stance
   is right for most of this codebase. It is wrong here: a tenancy leak is
   **silent** — nothing fails, wrong data simply renders. This phase must add one
   narrow suite that logs in as org A and asserts 404 on org B's ids across
   users, courses, sessions, certificates, assessments and SCORM. It is the one
   place tests earn their keep, and it must run before every deploy.
7. **`db:seed` and `db:reset-to-admin`** both need org awareness. Reset must
   refuse if it would leave an org without an admin, or the platform without a
   platform admin.

---

## 8. Delivery sequence

Ordered, because each step depends on the last. Waves map 1:1 onto these.

| # | Phase | Gate |
|---|---|---|
| 1 | Additive schema — `organizations`, 21 nullable `organization_id` columns, composite indexes | **Human checkpoint** §7.1 |
| 2 | SCORM static-content authentication + entitlement cache | **Blocks onboarding org #2** §7.4 |
| 3 | Backfill, `SET NOT NULL`, composite FKs, index drops | **Human checkpoint** §7.1, §7.2 |
| 4 | `organizationId` JWT claim, `TenantContextGuard`, `OrgScope` through 12 repositories | Token invalidation §7.3 |
| 5 | Global vs private content, platform-org sentinel reads, per-org storage prefixes | §7.5 |
| 6 | `modules/platform/` — org CRUD, global catalogue, cross-org analytics | |
| 7 | `client/app/(platform)/` route group; then the isolation suite | **Mandatory** §7.6 |
| 8 | Phase 2 RLS, then phase 3 RBAC | Architectural, not a migration |

Phases 1 and 2 are independent and may run concurrently. Everything from 4
onward is strictly sequential.

## 9. Non-goals / risks

- **RLS (Row-Level Security) is phase 2, and it is not free.**

  *What it is.* A PostgreSQL feature that attaches a filter **to the table
  itself**. Normally, permission to read `users` means permission to read every
  row. With a policy in place, Postgres silently restricts every query — even
  one that forgot its `WHERE` clause — to rows matching a session variable:

  ```sql
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  ALTER TABLE users FORCE  ROW LEVEL SECURITY;   -- applies to the table owner too
  CREATE POLICY org_isolation ON users
    USING (organization_id = current_setting('app.current_org')::int);
  ```

  Demonstrated on PostgreSQL 14 (2026-08-31):

  | Query, session pinned to org 2 | Rows returned |
  |---|---|
  | `SELECT * FROM users` *(no WHERE at all)* | only org 2's rows |
  | `SELECT * FROM users WHERE organization_id = 3` | **zero** |
  | same connection re-pinned to org 3 | only org 3's rows |

  *Why it matters here.* 120 of this codebase's queries are raw SQL strings, so
  there is no ORM hook that can inspect them. RLS sits **below** the SQL — it
  does not care how a query was written. A developer who forgets the org
  predicate gets an empty result instead of every tenant's data: **fail-closed
  rather than fail-open**. It is the only layer that covers all 120 strings
  without editing one of them.

  *Why it is not phase 1.* `SET LOCAL` binds to the connection running the
  query and lasts only for a transaction. Today there is one process-wide `Pool`,
  a singleton `db` handle, and **zero** transactions in the entire codebase — so
  a request's queries can land on any pooled connection. RLS therefore requires
  a `RequestScopedDatabase` that checks out a client, opens a transaction, sets
  the GUC, runs the handler, commits and releases. That is an architectural
  change to the data layer, not a migration.

  *Two operational gotchas.* RLS is bypassed by superusers and by the table
  owner unless `FORCE ROW LEVEL SECURITY` is set, so the application must
  connect to RDS as a **dedicated non-owner role**. And every policy predicate
  must be indexable, or it silently degrades the numbers in §3.8.
- **The retrofit surface is 12 files and ~40 query roots**, not 105 handlers.
  219 `FROM` clauses exist, but most are correlated subqueries anchored on
  `user_id`, which inherit the tenant from the driving row. That holds *only*
  because one user belongs to one org (decision 1). Revisit this spec entirely
  if that ever changes.
- **The content axis is service-enforced, not FK-enforced** (§3.5). Do not
  overstate the guarantee.
- **Reports export is unbounded.** At 500 learners × 10 courses it is 5,000
  rows — acceptable. Paginate or stream before an org reaches a few thousand
  learners. Already on the §10.3 follow-up list.
- **`PRODUCT_OVERVIEW.md` is stale** — it documents 18 tables and 9 modules; the
  code has 21 and 12. Update it as part of this phase or it will mislead whoever
  reviews the tenancy work.
- **Phase 3 (RBAC) seam.** `role` remains the portal selector; granular
  permissions arrive as a `permissions[]` claim. Nothing in this spec needs
  revisiting when they do.
