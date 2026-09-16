# BACKEND_STRUCTURE — Edstellar LMS Server

> **Scope:** everything under `server/`. The frontend has its own standards doc at
> `client/TASTE.md`; the two never cross-reference each other's internals.
>
> **Status:** NestJS 11 · TypeScript 5.9 · Drizzle ORM 0.38 · PostgreSQL.
> Migration from Next.js route handlers is COMPLETE — all 85 handlers live here.
> `client/` is a pure frontend with no database access. See §10.
>
> **Rule:** every new endpoint, table, or query MUST follow this document. If a
> decision contradicts it, update this document first, then write the code.

---

## Table of Contents

1. [Why the split exists](#1-why-the-split-exists)
2. [Directory structure](#2-directory-structure)
3. [The four layers](#3-the-four-layers)
4. [Request lifecycle](#4-request-lifecycle)
5. [Authentication & authorization](#5-authentication--authorization)
6. [Database & schema conventions](#6-database--schema-conventions)
7. [Query performance rules](#7-query-performance-rules)
8. [Error handling & API contract](#8-error-handling--api-contract)
9. [Configuration & secrets](#9-configuration--secrets)
10. [Migration ledger](#10-migration-ledger)
11. [Adding a new module — checklist](#11-adding-a-new-module--checklist)

---

## 1. Why the split exists

The application was a single Next.js app where 58 route handlers under
`app/api/**` held all business logic, shared a process with the UI, and reached
the database through a `globalThis`-cached client. That worked, but it meant:

- backend and frontend could not be deployed, scaled, or restarted independently
- there was no layering — auth, validation, SQL, and response shaping lived in
  the same 40-line function, repeated 58 times
- every route re-implemented its own auth check, so a forgotten check was a
  silently public endpoint
- queries were written ad hoc and ran N+1 loops against a *remote* database,
  where every round trip is a network hop

`server/` now owns all of it. `client/` is a pure frontend: it renders and calls
the API, and holds no database driver, schema, credential or signing secret.

---

## 2. Directory structure

```
server/
├── src/
│   ├── main.ts                  Bootstrap: global prefix, CORS, pipes, filters
│   ├── app.module.ts            Root module — imports features, binds global guards
│   │
│   ├── config/
│   │   ├── configuration.ts     Typed view of process.env (the ONLY env reader)
│   │   └── env.validation.ts    Fail-fast validation at boot
│   │
│   ├── common/                  Cross-cutting, feature-agnostic
│   │   ├── crypto/
│   │   │   └── password.util.ts scrypt hash/verify (format-locked — see §6.4)
│   │   ├── decorators/
│   │   │   └── index.ts         @Public, @Roles, @CurrentUser
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts
│   │   ├── guards/
│   │   │   ├── auth.guard.ts    Global — verifies the JWT
│   │   │   └── roles.guard.ts   Global — enforces @Roles
│   │   └── types/
│   │       └── authenticated-request.ts
│   │
│   ├── database/
│   │   ├── database.module.ts   @Global — the only global feature module
│   │   ├── database.service.ts  Owns the Postgres connection pool + Drizzle handle
│   │   ├── migration.runner.ts  Applies additive .sql on boot
│   │   ├── migrations/
│   │   │   ├── 0000_baseline_schema.sql   18 tables (authoritative DDL)
│   │   │   └── 0001_secondary_indexes.sql 20 indexes
│   │   └── schema/              Drizzle table definitions, one file per domain
│   │       ├── index.ts         Barrel — `import { users } from '@/database/schema'`
│   │       ├── users.schema.ts
│   │       ├── courses.schema.ts
│   │       ├── enrollments.schema.ts
│   │       ├── assessments.schema.ts
│   │       ├── sessions.schema.ts
│   │       ├── scorm.schema.ts
│   │       └── certificates.schema.ts
│   │
│   └── modules/                 One directory per business capability
│       ├── assessments/         admin builder + learner attempts
│       ├── courses/             courses, modules, lessons, assignments
│       ├── learner/             dashboard, progress, achievements, hours
│       ├── reports/             analytics + xlsx export
│       ├── scorm/               upload, assign, tracking, storage driver
│       ├── sessions/            sessions, roster, attendance
│       ├── users/               learners + employees
│       ├── auth/
│       │   ├── auth.module.ts
│       │   ├── auth.controller.ts
│       │   ├── auth.service.ts
│       │   ├── auth.repository.ts
│       │   ├── token.service.ts
│       │   ├── cookie.util.ts
│       │   └── dto/
│       └── certificates/
│           ├── certificates.module.ts
│           ├── learner-certificates.controller.ts
│           ├── admin-certificates.controller.ts
│           ├── public-certificates.controller.ts
│           ├── certificates.service.ts
│           ├── certificates.repository.ts
│           └── dto/
│
├── scripts/seed.mjs             Demo data for a fresh DB (npm run db:seed)
├── storage/scorm/               Extracted SCORM packages, served at /scorm/*
├── drizzle.config.ts            Introspection only — never `push` at production
├── nest-cli.json                Copies migrations/*.sql into dist
└── .env
```

### 2.1 Naming

| Kind | Convention | Example |
|---|---|---|
| Module | `<name>.module.ts` | `certificates.module.ts` |
| Controller | `<audience>-<name>.controller.ts` | `admin-certificates.controller.ts` |
| Service | `<name>.service.ts` | `certificates.service.ts` |
| Repository | `<name>.repository.ts` | `certificates.repository.ts` |
| DTO | `<verb>-<name>.dto.ts` | `list-certificates-query.dto.ts` |
| Schema | `<domain>.schema.ts` | `enrollments.schema.ts` |
| Migration | `NNNN_<description>.sql` | `0001_secondary_indexes.sql` |

Files are `kebab-case`; classes are `PascalCase`; Drizzle columns are
`camelCase` in TypeScript mapped to the existing `snake_case` SQL names.

### 2.2 One module per capability, one controller per audience

A capability that serves both portals gets **separate controllers per audience**,
not one controller with role branching inside handlers:

```
certificates/
├── learner-certificates.controller.ts   @Roles('learner')  /api/learner/certificates
├── admin-certificates.controller.ts     @Roles('admin')    /api/admin/certificates
└── public-certificates.controller.ts    @Public()          /api/certificates/verify
```

The audience is then visible in the file name and enforced by one decorator at
the class level, rather than by an `if (role === ...)` that someone can forget.

---

## 3. The four layers

Data flows in exactly one direction. **Never skip a layer, never reverse one.**

```
Controller  →  Service  →  Repository  →  Drizzle/Postgres
  HTTP          business      queries
```

| Layer | Owns | Must NOT |
|---|---|---|
| **Controller** | Routing, HTTP status, DTO binding, reading `@CurrentUser()`, shaping the response envelope | Contain business rules or build queries |
| **Service** | Business rules, eligibility logic, orchestration across repositories, throwing domain exceptions | Import Drizzle, touch `Request`/`Response`, know about HTTP |
| **Repository** | Every Drizzle query, explicit column lists, joins, aggregates | Contain business rules or throw HTTP exceptions |
| **Schema** | Table definitions + index declarations | Contain logic |

### 3.1 Concrete rules

- **A service never imports from `drizzle-orm` or `@/database/schema`.** If a
  service needs data, it asks a repository for it. This is what keeps the data
  layer swappable and the business rules readable.
- **A repository never throws `NotFoundException`.** It returns `null` or `[]`;
  the service decides whether that is a 404, a 403, or a legitimate empty state.
- **A controller never sees a database row.** Services return
  already-shaped objects.
- **Repositories always select an explicit column list.** `SELECT *` pulls
  `users.password` (a scrypt hash) into scope on every read, and that is exactly
  how a credential ends up serialised into a response by accident. The one
  method allowed to select `password` is named `...WithSecret` so it is obvious
  at the call site.

### 3.2 Cross-module dependencies

A module that needs another's behaviour imports the **module** and injects its
exported **service** — never its repository.

```ts
// certificates.module.ts
@Module({ providers: [CertificatesService, CertificatesRepository],
          exports: [CertificatesService] })   // ← service only, never the repository
```

Exporting a repository would let another module query your tables directly and
bypass your business rules.

---

## 4. Request lifecycle

```
HTTP request
  │
  ▼
CORS (main.ts)                  exact CLIENT_ORIGIN + credentials:true
  ▼
cookie-parser                   populates request.cookies
  ▼
AuthGuard        (global)       @Public? skip : verify JWT → request.user
  ▼
RolesGuard       (global)       @Roles? require request.user.role ∈ roles
  ▼
ValidationPipe   (global)       DTO validation + transform, whitelist:true
  ▼
Controller  →  Service  →  Repository  →  Postgres
  ▼
HttpExceptionFilter (global)    normalises errors to { message, errors? }
```

Everything except the controller/service/repository row is configured **once**
in `main.ts` and `app.module.ts`. Do not re-implement any of it per route.

---

## 5. Authentication & authorization

### 5.1 The model

- The server issues an **HttpOnly, SameSite=Lax cookie** named `lms_token`
  holding an HS256 JWT. `Secure` is set in production.
- **Client JavaScript can never read it.** The browser attaches it; the server
  reads it. Cross-origin calls need `credentials: "include"`, which is why
  `CLIENT_ORIGIN` must be an exact origin (a wildcard is illegal with credentials).
- The JWT claim set is:
  ```json
  { "userId": 5, "organizationId": 10, "role": "learner", "email": "...",
    "firstName": "Sneha", "lastName": "Kulkarni", "exp": 1788000000 }
  ```

  `organizationId` was added by the multi-tenancy work and is **required**:
  `TokenService.verify` rejects any token without it, because there is no
  organization a stale token could safely default to. Deploying that change
  signs every existing session out once, deliberately. See
  `specs/multi-tenancy.md` §4.1.
  `userId` — not `id` — is the `users.id` primary key. The name claims exist so
  the server-rendered shell can show the user without an extra round trip.

### 5.2 Deny by default

`AuthGuard` and `RolesGuard` are bound globally in `app.module.ts`. A new
controller is therefore **protected the moment it is written**. Opening a route
is an explicit, greppable act:

```ts
@Public()                       // no authentication at all
@Roles('admin')                 // authenticated AND admin
@Roles('learner')               // authenticated AND learner
// no decorator                 // any authenticated user
```

This inverts the legacy model, where every handler repeated a `requireAuth()`
call and a forgotten call meant a silently public endpoint.

### 5.2.1 Permissions, on top of roles

`@Roles()` says which portal's audience a route belongs to. `@Permissions()`
says what that audience must be allowed to do, checked by `PermissionsGuard`
against the `permissions[]` claim in the verified token (`specs/rbac.md` §4.1).
They AND together, and a route with no `@Permissions()` is open to its whole
audience.

**Every entry in `common/permissions.ts` has at least one guard behind it, and
that is an invariant worth keeping.** It was not true when the roles UI first
shipped: 14 of 19 entries were checked nowhere, so an organization could untick
a box and the role kept the capability. A permission with no guard is worse
than no permission — it is a screen that lies. When you add an entry to the
catalogue, add the decorator in the same change; when you remove the last route
that checks one, remove the entry.

The rule for which routes carry one:

> A permission named `view_*` gates a read. Everything else gates writes.

Content reads (courses, modules, lessons, sessions, the SCORM library) stay
open to any admin-portal role on purpose — an `assign_learning` role has to
list courses in order to assign one. The four `view_*` permissions cover the
reads that carry something worth withholding: the dashboard, the employee
list, reports, and certificates.

A **delegated** route is the one exception to reading the scope from the
caller's token: `@PlatformAdmin()` routes under
`/platform/organizations/:organizationId` mint an `OrgScope` for the org in the
path via `OrganizationsService.scopeFor()`. Read that method's docblock before
adding a caller — behind a weaker guard it would be a cross-tenant write.

### 5.3 Rules

- **Never read a role from anything but the verified JWT.** Not a request body,
  not a query param, not a second cookie. The legacy middleware trusted an
  unsigned `lms_user` cookie, so editing it to `{"role":{"slug":"lms_admin"}}`
  rendered the admin shell.
- **Ownership is checked in the service, not the query.** Fetch the row, compare
  `row.userId !== user.userId`, throw `ForbiddenException`. Distinguishing 403
  (exists, not yours) from 404 (does not exist) is deliberate and tested.
- **Login must not distinguish "no such user" from "wrong password"** — one
  message for both, or the form becomes an account-enumeration oracle.
- **Never put the token in a response body.** It belongs in the cookie only.

---

## 6. Database & schema conventions

### 6.1 The tables already exist

All 18 tables hold production data in Postgres. The Drizzle schema in
`database/schema/` **mirrors** them; it does not define them. Column names,
types, defaults, and constraints must match the live database exactly.

### 6.2 Migrations are additive and idempotent

`DatabaseService.onModuleInit()` runs every `.sql` in `database/migrations/` in
filename order on boot. Every statement must be safe to re-run:

```sql
CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons (module_id, is_active);
```

> **Never run `drizzle-kit push` against the production database.** `push`
> resolves a schema drift by rewriting the table, and a cosmetic disagreement
> between Drizzle metadata and the live DDL is enough to trigger it.
> `drizzle.config.ts` exists for introspection and for generating SQL to review
> by hand. `npm run db:push` is for a scratch database only.

A change that is not additive (dropping a column, changing a type, backfilling)
is a **human checkpoint**: write the SQL, review it, run it deliberately.

### 6.3 Declaring indexes

Declare an index in the Drizzle table definition **and** in a migration file.
The declaration documents intent next to the table; the migration is what
actually executes.

Do not add an index that duplicates the leftmost prefix of an existing `UNIQUE`
constraint — Postgres already backs that constraint with a btree index, which
serves leftmost-prefix lookups. `UNIQUE(user_id, course_id)`
serves lookups by `user_id`, so only the reverse direction (`course_id`) needs one.

### 6.4 Format-locked code

`common/crypto/password.util.ts` is **not free to change**. Every row in
`users.password` was produced by `scryptSync(password, salt, 64)` with a 16-byte
hex salt, stored as `<derivedKeyHex>.<saltHex>`. Changing the parameters locks
out every existing account. Migrating to a stronger KDF means re-hashing on next
successful login, not editing the constants.

`modules/auth/token.service.ts` is similarly locked **for the duration of the
migration**: the un-migrated Next.js routes verify these tokens with the legacy
implementation, so the wire format must stay identical until §10 is complete.

---

## 7. Query performance rules

Depending on deployment, Postgres may be colocated or remote — either way, the
count of round trips matters more than the cost of any single one, so the rules
below still apply.

### 7.1 No N+1. Ever.

This is the single most important rule, and it is the pattern the legacy code
fell into repeatedly.

```ts
// ❌ WRONG — one query per course, in a loop
const courses = await getCourses(userId);
for (const course of courses) {
  course.bestScore = await getBestScore(userId, course.id);   // N round trips
}

// ✅ RIGHT — one query, aggregate in SQL
const rows = await db
  .select({ id: courses.id, bestScore: max(attempts.percentage) })
  .from(assignments)
  .innerJoin(courses, eq(courses.id, assignments.courseId))
  .leftJoin(attempts, eq(attempts.userId, assignments.userId))
  .where(eq(assignments.userId, userId))
  .groupBy(courses.id);
```

**Worked example.** The legacy `evaluateCourseCompletion()` issued three
sequential queries per course (lesson counts, best score, "does an assessment
exist"). The course list called it per row, so a learner with 8 courses cost
**24 round trips**. `CertificatesRepository.getCompletionSnapshot()` collapses
the same result into **one** query using correlated scalar subqueries.

### 7.2 Aggregate in SQL, not in JavaScript

Counting, summing, averaging, max/min, and percentage math belong in the query.
Pulling rows into Node to `.filter().length` them transfers data you then throw
away.

### 7.3 Select only what the response needs

Explicit column lists, always (§3.1). This is a performance rule and a security
rule at the same time.

### 7.4 Index every column you filter or join on

If you write a `where` or a `join` on a column, it needs an index — unless it is
already the leftmost column of a `UNIQUE`. Add it to both the schema and a
migration (§6.3).

### 7.5 Prefer one round trip over one elegant query

When a single statement would be unreadable, a correlated-subquery `SELECT` that
returns one row of scalars (as in `getCompletionSnapshot`) beats three tidy
queries. Readability matters; round trips matter more.

### 7.6 Paginate anything unbounded

Any list that grows with users, courses, or attempts takes `limit`/`offset` (or
keyset) parameters. `listForAdmin` is currently unbounded — see §10.

---

## 8. Error handling & API contract

### 8.1 Response envelope

Success responses are plain JSON objects named for their content:

```json
{ "certificates": [ ... ] }
{ "certificate": { ... } }
{ "user": { ... } }
{ "ok": true }
```

Errors are normalised by `HttpExceptionFilter` to:

```json
{ "message": "Certificate is not revoked" }
{ "message": "courseId must be an integer", "errors": { "courseId": ["..."] } }
```

This is the shape `client/lib/api-client.js` parses into its `ApiError`. Nest's
default envelope (`{ statusCode, message, error }`, with `message` as a string
**array** for validation failures) would break that contract silently — which is
why the filter exists.

### 8.2 Status codes

| Code | Meaning | Thrown as |
|---|---|---|
| 400 | Malformed input | `BadRequestException` / `ValidationPipe` |
| 401 | No or invalid credential | `UnauthorizedException` (AuthGuard) |
| 403 | Authenticated but not allowed, incl. not-the-owner | `ForbiddenException` |
| 404 | Resource does not exist | `NotFoundException` |
| 409 | Conflicts with current state | `ConflictException` |
| 422 | Well-formed but fails a business rule | `UnprocessableEntityException` |

### 8.3 Never leak internals

The filter replaces the body of any **non-`HttpException`** with
`{ "message": "Internal server error" }` and logs the stack server-side. Do not
put a raw error message in a response.

A deliberately constructed `HttpException` keeps its message even at 5xx,
because that text was written for the caller. This matters: a
`ServiceUnavailableException` has to be able to say *what* is unavailable —
masking it made a misconfigured server look identical to a crash, and cost real
debugging time when R2 credentials were absent in production. The distinction is
provenance, not status code: an author wrote the former, a driver or a
`TypeError` produced the latter, and only the latter can leak a connection
string.

### 8.4 Best-effort side effects must not break the caller

Work that is secondary to the request must never fail it. `autoIssue()` catches
everything and returns `null` — a certificate failure cannot break marking a
lesson complete. Log the reason; do not propagate.

---

### 8.5 Length caps on free text

`common/content-limits.ts` holds them, and a `description` is capped at 450
characters on every DTO that has one — course, module, lesson, assessment,
session. One limit, so an admin never discovers by being refused that one form
is stricter than another.

The columns behind them stay `text`. The cap is a product rule that may move,
and a rule that moves does not belong in a type that needs a migration to
change. Nothing was over the limit when it was introduced — the longest
description in the database was 198 characters — so no existing row became
uneditable, which is the check to repeat before lowering it.

The browser applies the same number as a `maxLength` (`client/lib/content-limits.js`)
so the admin is stopped while typing rather than refused after writing three
paragraphs. That is courtesy; this is enforcement.

## 9. Configuration & secrets

- **`config/configuration.ts` is the only file that reads `process.env`.**
  Everything else injects `ConfigService` and reads a namespaced key
  (`auth.jwtSecret`, `database.url`). Use `getOrThrow` for anything required.
- **No fallback values for secrets.** The legacy code defaulted `JWT_SECRET` to
  a literal string, which silently produced forgeable tokens in any environment
  that forgot the variable. `env.validation.ts` fails the boot instead.
- **No secret is ever committed.** `.env` is gitignored.

### 9.1 Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `DATABASE_SSL` | no (`false`) | Set `true` if the Postgres server requires/terminates TLS |
| `JWT_SECRET` | yes | HMAC key, ≥32 chars; must match `client/.env.local` during migration |
| `PORT` | no (3001) | HTTP port |
| `CLIENT_ORIGIN` | no | Exact frontend origin for CORS — no wildcard |
| `COOKIE_DOMAIN` | no | Omitted for localhost; set to the shared parent domain in production |
| `AUTH_TOKEN_DAYS` | no (7) | Token + cookie lifetime |
| `SCORM_STORAGE_DRIVER` | no (`local`) | `local` (single-instance) or `s3` (R2, multi-instance) — see §10.9. `s3` reuses the `R2_*` variables |
| `SCORM_STORAGE_PATH` | no | Local SCORM root |
| `R2_ACCOUNT_ID` | for video | Cloudflare account id; used to derive the endpoint |
| `R2_ACCESS_KEY_ID` | for video | R2 API token key |
| `R2_SECRET_ACCESS_KEY` | for video | R2 API token secret |
| `R2_BUCKET` | for video | Bucket holding lesson videos and captions |
| `R2_ENDPOINT` | no | Account-level S3 endpoint, **without** the bucket path |
| `VIDEO_URL_TTL_SECONDS` | no (900) | Lifetime of a presigned playback URL |
| `UPLOAD_URL_TTL_SECONDS` | no (3600) | Lifetime of a presigned upload URL |
| `VIDEO_MAX_BYTES` | no (2 GiB) | Rejected at presign, re-checked against R2 on confirm |
| `CAPTION_MAX_BYTES` | no (2 MiB) | Caption uploads are proxied, so this is a real body cap |
| `DOCUMENT_MAX_BYTES` | no (100 MiB) | Cap for an uploaded document — a slide deck, not a feature film |
| `UPLOAD_STORAGE_PATH` | no (`./storage/uploads`) | Root for files this process stores and serves itself — course thumbnails (§10.10) |
| `REPORTING_REFERENCE_DATE` | no | Pins "today" for reports. Leave UNSET in production — set it only to demo the seeded period |
| `ORG_NAME` | no (`Edstellar`) | Name of the first real organization created by `db:migrate:tenancy` |
| `ORG_SLUG` | no (`edstellar`) | Organization `db:seed` seeds into |

The R2 variables are **not** boot-required: without them the API starts, logs a
warning, and returns 503 from the video routes only. `S3_API_ENDPOINT` from the
Cloudflare dashboard includes the bucket in its path and must not be used as
`R2_ENDPOINT` — the SDK appends the bucket itself.

---

## 10. Migration ledger

Update this table with every module you move.

| Module | Handlers | Location |
|---|---|---|
| auth | 4 | `server/src/modules/auth` |
| users / employees | 10 | `server/src/modules/users` |
| courses / modules / lessons / assignments | 17 | `server/src/modules/courses` |
| assessments / questions | 12 | `server/src/modules/assessments` |
| sessions / roster / attendance | 11 | `server/src/modules/sessions` |
| learner (dashboard, courses, lessons, progress, achievements, leaderboard, learning-hours, change-password) | 10 | `server/src/modules/learner` |
| scorm (upload, assign, tracking, static content) | 9 | `server/src/modules/scorm` |
| certificates | 5 | `server/src/modules/certificates` |
| analytics / reports / export | 6 | `server/src/modules/reports` |
| media (lesson video + captions in R2) | 7 | `server/src/modules/media` |
| scorm attempt history (admin view) | 1 | `server/src/modules/scorm` |
| scorm granular data-model log (learner write + read, admin read) | 3 | `server/src/modules/scorm` |
| lesson video progress (learner) | 1 | `server/src/modules/media` |
| manual certificate issue (admin) | 1 | `server/src/modules/certificates` |
| session completion (admin) | 1 | `server/src/modules/sessions` |
| document upload + lesson resources | 4 | `server/src/modules/media`, `server/src/modules/courses` |
| organizations (platform org resolution) | 0 | `server/src/modules/organizations` |
| leaderboard | 1 | `server/src/modules/leaderboard` |
| learning-hours | 1 | `server/src/modules/learning-hours` |
| roles & permissions (org admin) | 7 | `server/src/modules/roles` |
| roles & user creation, delegated to a platform admin | 5 | `server/src/modules/roles` |
| trainer portal (own sessions, participants, attendance) | 4 | `server/src/modules/sessions` |
| team learning (manager) | 1 | `server/src/modules/learner` |
| change password (any authenticated role) | 1 | `server/src/modules/auth` |
| course thumbnail (upload + rollback) | 2 | `server/src/modules/media` |
| learning journeys (admin CRUD, assign, learner path) | 11 | `server/src/modules/journeys` |
| badges (learner list; awards fire from completion triggers) | 1 | `server/src/modules/badges` |
| activity log (dashboard Recent Activity; written from six modules) | 1 | `server/src/modules/activity` |
| admin analytics page + reports builder (group / individual / comparison) | 6 | `server/src/modules/reports` |
| course authoring (course-level lessons, staged/link, assessment placement) | 3 | `server/src/modules/courses` |
| edstellar services (catalogue requests, org-scoped) | 3 | `server/src/modules/services` |

### 10.14 Edstellar Services

An org admin asks Edstellar for a service — a TNA, a leadership programme, a
platform — and the request is tracked until somebody at Edstellar closes it.
`0021_service_requests.sql` adds the one table; `0022_services_permission.sql`
grants the new permission to existing admin roles.

```
GET  /api/admin/services/requests       this org's requests + a count per status
GET  /api/admin/services/requests/:id   one, with its full questionnaire
POST /api/admin/services/requests       file one
```

**The CATALOGUE is not served from here.** `common/edstellar-services.ts` holds
the 42 service NAMES and nothing else; the browser's mirror
(`client/lib/edstellar-services.js`) holds the same names plus the grouping,
the descriptions and the 14 per-service question sets — about 70KB. None of
that is enforceable: the grouping is navigation, the descriptions are copy, and
the question sets decide what to render while the answers are stored as one
JSON blob either way. An endpoint returning it would be a round trip to fetch a
constant, and copying it server-side would double the maintenance to validate
nothing.

What IS enforced is the name, because that is the field a human at Edstellar
routes by. A request naming something not offered is refused with a 422 — which
is also how a drift between the two files announces itself.

**`answers` is a `jsonb` document, and that is a deliberate trade with a stated
cost.** Each service asks different questions, 14 sets exist today, and they
change whenever Edstellar changes its offering. Relationally that is ~200
mostly-null columns or an answers table keyed by questions that are not rows.
The cost: `answers` is **not queryable as structured data**, and nothing should
start filtering or reporting on it without first promoting the field it needs
to a real column. `timeline` and `budget` were promoted for exactly that
reason — the list screen shows them, and a JSON path in a WHERE clause is how a
document column quietly becomes a schema.

**A request is ACTIVITY, so `orgScope`, never `contentScope`** (§10.12's rule,
applied before rather than after a leak). The catalogue is shared by every
tenant; a request against it belongs to one. Verified: each org gets its own
`REQ-2026-0001`, a cross-tenant read 404s, and neither org sees the other's.

**There is no route that moves a request past `pending`.** Only Edstellar does
that, and Edstellar is a platform admin. A status write on this controller
would let a tenant mark its own request "Proposal sent". The reference mock's
super-admin view — every tenant's requests in one list — is a `@PlatformAdmin`
route that does not exist yet, and must never be built by widening this one.

**Everything identifying comes from the verified token**, never the body: the
organization, the user id, and the name and email the request is signed with. A
body-supplied `contact_email` would let an admin file in a colleague's name,
and this is the one feature whose output leaves the building.

`request_services` is a new permission with guards on both routes in the same
change (§5.2.1). It is separate from every other permission because it is the
one action that reaches OUTSIDE the tenant — an org may well want content
admins building courses without being able to open a commercial conversation on
its behalf. `0022` grants it to existing `is_system` admin roles and bumps
`perm_version`, the same shape as `0016_journeys_permission.sql`; read that
file's header for why an automatic backfill is safe here.

A fourth shape bug of the §10.10 family was caught while testing this: `create`
and `findById` are Drizzle calls returning camelCase while `list` names its
columns in snake_case. Both are shaped now. That is three occurrences in one
day — when a repository mixes `.select()` with raw SQL, assume the casings
disagree until checked.

### 10.13 Course authoring: staged lessons, and assessments at three levels

`0020_course_authoring.sql` turns the course detail page into the one place a
course is built. Read the migration itself first — its comments carry the
safety argument. The summary:

**A lesson belongs to a COURSE and may belong to a module.** `lessons.course_id`
is new and NOT NULL; `lessons.module_id` is now nullable. Both module foreign
keys changed from `ON DELETE CASCADE` to `ON DELETE SET NULL`, because cascade
was only coherent while a lesson could not exist without a module — deleting a
grouping must not destroy the work inside it.

**A lesson with no module is STAGED, and staged means invisible.** It is not
delivered, earns no learning hours (§10.4), counts toward no completion
(§10.11) and cannot earn a certificate. That is what made the change safe:
roughly 89 queries across 14 modules reach a lesson through
`JOIN course_modules cm ON cm.id = l.module_id`, and a NULL `module_id` drops
out of every one of them unchanged. Deciding that a staged lesson SHOULD count
is not a one-line change — it is 89 rewrites and four re-proved invariants.

**Assessments attach at three levels plus none.** `link_type` is STORED, not
derived from which id is set, because `course` (the final) and `none` (being
written) both carry neither id and mean opposite things. `module_id` and
`lesson_id` are `ON DELETE SET NULL` with a backfill to `none`: deleting the
module an assessment hung on must not delete the assessment and its questions.

**Five question types across two storage shapes** — `common/assessment-questions.ts`,
the sixth catalogue-as-code. `mcq`, `truefalse` and `multiselect` keep their
choices as `assessment_options` rows; `fillblank` and `matching` store the
expected answer in `assessment_questions.correct_answer`. `assertQuestionShape`
replaced `assertHasCorrectOption`, whose rule ("at least one correct option")
was right for multiple choice and impossible for the two types that have no
options at all.

**Seven lesson content types** — `common/lesson-content.ts`, mirrored by
`client/lib/lesson-content.js`. Each entry carries its own `durationRequired`
rule, which is what makes it code rather than data: video measures its own
runtime, everything else must declare one or be worth zero hours (§10.4).

Endpoints added:

```
GET   /api/admin/courses/:courseId/lessons     lessons of a course, staged flagged
POST  /api/admin/courses/:courseId/lessons     create, module optional
PATCH /api/admin/lessons/:lessonId/module      link / unlink (null = staged)
```

#### Four shape bugs fixed alongside it

All four were the §10.10 defect — handing a raw Drizzle row to a caller that
reads the API's snake_case — and all four were silent:

- **`createQuestion` never wrote `question_type` or `correct_answer`.** The
  input interface declared both and the `.values()` omitted both, so every
  question saved as `mcq`. A fill-in-the-blank passed validation and then
  landed as an mcq with zero options: ungradeable, and nothing said so.
  `updateQuestion` had always written them, which is why editing a question
  fixed it and creating one did not.
- **`attachOptions` mixed two casings.** Questions came from a Drizzle
  `.select()` (camelCase), options from raw SQL (snake_case). Both admin and
  learner quiz pages read `question.question_text`, so **every question
  rendered with a blank title on both portals**. It now maps to snake_case.
- **`listOptionsForQuestion` disagreed with its own sibling.** A `.select()`
  where `listOptionsForAssessment` used raw SQL, so the same option arrived
  under two different names depending on which read produced it. Now raw SQL.
- **`getForAdmin` returned the raw assessment row.** Shaped now, like the
  learner's read already was.

**Module reorder now exists.** `course_modules.sort_order` was in the table and
the Outline numbers by it, but no DTO carried it and no `.set()` wrote it, so a
course's modules could not be reordered at all. `ModuleDto.sort_order` and the
repository's `.set()` close it; the service passes the module's current value
when the caller omits the field, so an ordinary title edit cannot shuffle the
course.

`GET /api/admin/courses/:id` also gained `enrolled_count`, **org-scoped** for
the reason §10.12 and `listWithStats` both record: the course may be
platform-owned and shared, but an assignment is activity and belongs to one
tenant. Unscoped, the detail header would have contradicted the library card
next to it.

#### The Assessment Builder is gone

There is no `/admin/assessments` page and no sidebar entry. An assessment only
means something in the context of what it tests, so it is authored on the
course page, where the placement control can offer the real modules and
lessons. The API routes and the `build_assessments` permission are unchanged —
§5.2.1's invariant still holds, every entry in `common/permissions.ts` still
has a guard behind it.

One consequence to know: the course page is reached with `manage_courses`, and
its Assessments tab writes behind `build_assessments`. A role holding the first
without the second sees the tab and is refused on save. That is two permissions
on one screen, and the refusal is legible rather than silent, but it is the
kind of thing to fix by hiding the tab if the roles UI ever makes that
combination common.

### 10.12 Admin analytics, the reports builder, and the activity log

Three admin screens — Dashboard, Analytics and Reports — read from
`modules/reports`. Dashboard says what is true now, Analytics says how it got
there, Reports is the evidence. They share one aggregate and one definition of
an hour, deliberately.

**`AnalyticsService.snapshot()` is computed once and read twice.** The
dashboard and the reports page both need the per-learner aggregate, the status
split and the department roll-up. Before this they would have been two
near-identical blocks and their completion rates would eventually have
disagreed — the same failure §10.4 records for hours, one layer up. Neither
caller recomputes; they only choose what to return.

**`statusOf()` now means the coursework is done.** It used to read
`has_passed === 1 -> completed`, which answers a different question from the
one the label asks: a learner who passed one quiz and had opened none of their
other courses counted as complete, and a learner who finished a course carrying
no assessment never could. With sparse data that mostly looked plausible; with
a real history the donut collapsed to 90% complete and stopped distinguishing
anybody. It is now "every assigned lesson finished" — what complete means
everywhere else (§10.11).

**Hours still come only from `LearningHoursService`.** The Analytics trend
charts needed minutes bucketed by calendar period and split by mode, which the
fixed month/week buckets could not express. Rather than write a second sum,
three consumers were added to the same `lessonSource` fragment —
`minutesByPeriod`, `minutesByPeriodAndMode`, `minutesByUserInWindow` — and the
fragment gained `lesson_id` and `content_type` to support them. §10.4 stands:
there is still exactly one place that knows what an hour is.

**The period axis is folded from months, never re-truncated.** Five
granularities (monthly · quarterly · half-yearly · yearly · multi-year) are
built by folding monthly rows in `periods.util.ts`, not by issuing five
differently-`date_trunc`ed queries. Five variants would be five chances for a
quarterly total to disagree with the sum of its own months. The axis is also
trimmed to the data's real extent before the per-granularity cap, because an
axis padded with empty buckets reads as a collapse in activity that never
happened.

**`sufficient: false` is part of the contract.** When fewer than three buckets
carry data the response says so and the page shows a note in place of a claim.
Two points are a line segment, not a trend, and a chart drawn anyway invites a
conclusion the data cannot support.

**Mode of learning is derived, not stored.** `lessons.content_type` says what a
lesson is, except for `session`, where the delivery mode belongs to the session
(`sessions.session_type`) and the lesson is only its companion (§10.7). The
CASE reaches through the training course for that one type and takes the
lesson's word for every other.

#### The reports builder

Three scopes behind three routes, all `@Permissions('view_reports')`:

```
POST /api/admin/reports/group        one section per selected report type
POST /api/admin/reports/individual   one person's whole record
POST /api/admin/reports/comparison   N items of a dimension x M metrics
GET  /api/admin/reports/options      what the controls may offer
```

POST for a read is deliberate: a comparison carries two arrays and a group
carries one plus four filters, which as a query string meets a proxy's URL cap.
They return 200, not 201 — nothing was created.

**Five report types, not the eight the reference mock offered.** The three left
out have nothing behind them, and a type that always returns an empty table is
the screen-that-lies failure §5.2.1 exists to prevent: Learning Path Progress
(`journeys` is empty), Certificates Issued (folded into Course Completion,
since every certificate here follows a completion already in it) and Enrolments
self-vs-assigned (there is no self-enrolment in this product, so the split
would be 100%/0% by construction). Adding one back means adding its builder in
the same change, the rule `common/permissions.ts` already follows.

**The row cap is applied after the KPIs.** `ROW_CAP` shortens the table only;
the summary always describes the whole result. A truncated table beside a
truncated total would be wrong twice.

**Every report downloads as .xlsx, and the download is NOT capped.** Three
routes mirror the three builders:

```
POST /api/admin/reports/group/export
POST /api/admin/reports/individual/export
POST /api/admin/reports/comparison/export
```

Each takes the same DTO as its JSON counterpart and rebuilds the report through
the same service, so the file can never describe a different query from the one
the admin just looked at. The group export passes `full`, which skips
`ROW_CAP`: the cap exists so a browser is not asked to lay out 20,000 table
rows, and a spreadsheet has no such problem. Serialising the on-screen rows
instead would have produced a file silently stopping at row 500 while its own
SUMMARY block described the whole population — wrong, and wrong in a file that
leaves the building. Verified by dropping `ROW_CAP` to 10: the screen showed 10
of 112 and said so; the file carried 112.

They are separate routes rather than a `format` flag, because the response is a
binary stream with its own headers and an `@Res()` handler — folding that into
a route that usually returns JSON gives one method two contradictory return
types.

One sheet per report section, so a Group report over three types arrives as
three tabs. Each sheet repeats what the screen shows in the same order — title,
window, generated-at, the KPI summary, then the table — because a bare grid of
numbers with no window on it cannot be checked against anything later. Excel
caps a sheet name at 31 characters and rejects duplicates, so titles go through
`sheetName()` rather than straight onto the tab; both limits are hit by real
data ("Individual report — Manish Gupta" is 33).

**`Access-Control-Expose-Headers: Content-Disposition` is load-bearing.** CORS
exposes only a handful of response headers to page JavaScript by default, and
the API is a different origin from the UI — so the server was naming every file
carefully and the `fetch` that saved it could not read the name. Downloads
landed under whatever fallback the caller had hardcoded. This affected the two
pre-existing xlsx downloads too, which is why they hardcode their filenames.

**`job_level` and `location` are closed lists** (`common/workforce.ts`, mirrored
by `client/lib/workforce.js`), because both are Reports filter and comparison
dimensions and a dimension is only useful if its values repeat. That is the
lesson from `job_role`, which is free text: 18 distinct values across 20
learners, so filtering by one returns one person. `department` works as a
dimension by luck, not design. There is deliberately no table behind either
list — a table would let an org invent a value, which is exactly what makes
`job_role` useless.

`common/course-taxonomy.ts` is the fourth catalogue-as-code in this codebase,
after `permissions.ts`, `badges.ts` and `workforce.ts`. Same argument every
time: a value means something only because something reads it, and here two
things do — the library's colour map, and the `Compliance` rule above.

`0018_workforce_and_activity_log.sql` also rewrites two legacy location
spellings. A row holding a value the filter cannot offer is invisible to every
location-filtered report — a silent omission, not an empty cell.

#### The Course Library

`0019_course_library.sql` adds five columns to `courses` and the admin library
reads all of them: `category`, `is_mandatory`, `expiry_months`, `tags`,
`archived_at`.

**`Compliance` is a category with behaviour.** `isMandatory()` in
`common/course-taxonomy.ts` returns true for it whether or not the flag is
set, and it is the only category where a renewal cadence means anything. That
implication lives in one function — never re-stated at a call site — so the
card ribbon, the KPI count and any future report cannot disagree about whether
a course is compulsory. The create/edit form locks the Mandatory switch on for
compliance for the same reason: an unticked box there would be a lie.

`expiry_months` is **recorded, not enforced**. The card prints "Renews every 12
mo" and nothing ages a completion out — that needs a scheduled re-assignment
and there is no scheduler here. Do not read the column as though completions
were expiring.

Moving a course out of Compliance CLEARS its cadence (`nextExpiryMonths`).
Otherwise a Technical course would keep printing a renewal it no longer has.

**Archive is a third state, orthogonal to published/draft**, which is why it is
`archived_at` and not a third value of `is_active`: an archived course
remembers whether it was published, and restoring returns it to that rather
than to a guess. The list never mixes the two sets — `?archived=true` swaps
between them — because an archived course appearing in the assign-learning
picker is the thing archiving exists to prevent.

**Archiving does not withdraw a learner's assignment.** It removes the course
from the library's default view and stops it being assigned again; somebody
halfway through keeps their progress. Deleting an in-progress training because
an admin was tidying up has no undo.

`POST /admin/courses/bulk` does publish / unpublish / archive / restore over a
selection, one statement per action (§7.1). Its predicates are the guards:
`organization_id` (not `contentScope` — a platform-owned course must not be
publishable by a tenant), `session_id IS NULL` (a session training follows its
session, §10.7), and for publish `archived_at IS NULL`. A request naming ids
that fail those simply affects fewer rows and reports the count, rather than
erroring on the first one.

Single-card actions call the same endpoint with one id, so there is one code
path and one result shape for both.

The card's Enrolled count opens a roster popup backed by the EXISTING
`GET /admin/courses/:id/assignments` — the card needed a dialog, not a new
endpoint. It is fetched on open rather than with the library: eleven rosters
nobody asked for is eleven queries and a payload several times the size of the
grid.

**Every activity subquery over shared content is `orgScope`, not
`contentScope` — and this is a CLASS of bug, not one query.** The course row itself is content and may be platform-owned;
its assignments, completions and attempts are activity and belong to one
tenant each. Unscoped, an org admin's card showed 13 enrolments on a global
course of which 2 were another tenant's — a cross-tenant count, and a number
that disagreed with the roster popup beside it, which was scoped correctly.
The mismatch is what exposed it: two figures for the same thing on one screen
is a useful alarm, and worth preserving rather than reconciling by making the
roster agree with the wrong number.

**The same pattern was then found and fixed in three more places**, all latent
because no platform-owned assessment or SCORM package exists in the demo data
yet — one publish away from being live:

| Query | Was | Now |
|---|---|---|
| `AssessmentsRepository.listByCourse` | attempts counted across tenants | `orgScope` on the attempt |
| `ScormRepository.listPackages` | assigned / completed counted across tenants | `orgScope` on assignment and tracking |
| `ScormRepository.packageAssignments` | listed **every tenant's learners** by name, email and department | `orgScope` on the assignment, beside the existing `contentScope` on the package |

That last one was a PII leak, not a miscount. The rule to apply when reading
any of these queries:

> If the outer row is CONTENT (`contentScope` — a course, assessment, SCORM
> package) and the subquery counts ACTIVITY, the subquery needs its own
> `orgScope`. The content predicate answers "may this admin see this thing";
> it says nothing about whose activity is being counted against it.

Two places were checked and deliberately left alone: `SessionsRepository.list`
(sessions are org-owned, so a roster count correlated to one is already
confined) and `ScormRepository.sweepUnclaimed` (the server tidying up after
itself — its NOT EXISTS checks MUST span tenants, or a package another tenant
has history on would be deleted).

**`needs_attention`** — no assessment attached, or enrolments with completion
under 40% — is the reference's "Red Flags" tile. It is a prompt, not a verdict:
a course published yesterday is legitimately at 0%, which is why the tile reads
"need attention".

#### The Manage Users directory

`GET /api/admin/users/directory` backs the Manage Users table: every account in
the organization — admin, manager, trainer, learner — with the progress figures
the table shows, plus the KPI counts above it.

**Deliberately separate from `GET /api/admin/employees`**, which stays
learners-only. That endpoint also feeds the assign-learning picker and the
session roster, and both mean "people who can be given a course": widening it
would have quietly offered admins and trainers as assignees. Two callers, two
questions, two methods (`UsersRepository.listDirectory`).

Three things are load-bearing:

- **`role_label` comes from the RBAC role, not `users.role`.** The portal
  selector collapses a Manager into `learner` (`specs/rbac.md` decision 2), so
  a table rendering `users.role` shows every Manager as a Learner and gives an
  admin no way to tell them apart.
- **`last_activity` is the latest completion or attempt, and null when there is
  none.** The column existed before but printed `created_at`, so every row
  claimed the person had last been active on the day they joined — a date that
  was always wrong and never looked it.
- **`can_manage` is `role === 'learner'`, and the UI disables on it.**
  `assertMutableLearner` refuses to edit, deactivate or delete anything else,
  so those actions must render disabled rather than fail with a 403 when
  clicked — §5.2.1's screen-that-lies rule applied to a button. The API is
  still what enforces it; the flag only stops the UI offering what it knows
  will be refused.

The KPI counts are reduced from the rows already fetched rather than from five
`COUNT(*)` queries beside them, so the tiles can never disagree with the table
underneath. The browser refetches after every mutation for the same reason —
patching a row locally moved the status chip and left "Inactive users" saying
zero.

#### The activity log

`activity_log` backs the dashboard's Recent Activity panel. `ActivityService`
is exported by a dependency-free module (like `JourneyGateService`, §10.11) so
any module may import it, and six do: users, courses, assessments, sessions and
certificates write to it on create, publish, assign, deactivate, issue and
revoke.

**`record()` never throws.** It is best-effort (§8.4), so no caller wraps it and
publishing a course can never fail because a log row did not write. The cost is
stated where it matters: **this is a product feature, not an audit trail** —
the entries that are missing are precisely the ones whose write failed. If a
real audit trail is needed it is a different table with different guarantees;
do not quietly promote this one.

Activity is `orgScope`, never `contentScope`. A platform-owned course uploaded
once must not appear in every tenant's feed as though their own admin did it.

#### Seeding a history

`npm run db:seed-history` backdates and thickens one organization's learning
history so the trend charts have something to draw. Dry-run by default,
`--commit` to apply, matching `db:reset-to-admin` and `db:clean-orphan-scorm`.

**It is destructive to learner progress in the target org** — completions,
attempts, certificates, rosters, attendance and activity are deleted and
regenerated, because a coherent history cannot be layered on top of an
incoherent one: a completion dated before its own assignment is worse than no
history. Courses, lessons, assessments and accounts are never touched. The PRNG
is fixed-seed, so two runs produce identical data.

It exists because the demo organization held four lumpy months with 83% of all
completions inside one of them. Every window coarser than Monthly collapsed to
a single bar, and no amount of frontend work fixes that.

One consequence worth knowing: it issues certificates, which broke
`test:isolation`'s certificate fixture — that fixture assumed its learner held
none and got a 409. The fixture now picks a course the learner has no
certificate for, which is what a fixture should have done anyway.

### 10.9 SCORM object storage, and the granular data-model log

`SCORM_STORAGE_DRIVER` now has both implementations §10.3 asked for.

| Driver | Files live | Served by | Multi-instance |
|---|---|---|---|
| `local` (default) | `SCORM_STORAGE_PATH/<package_dir>/` | `useStaticAssets` | **no** |
| `s3` | R2, `tenants/<orgId>/scorm/<packageDir>/` | `ScormContentHandler` | yes |

`scorm_packages.storage_prefix` records which: NULL means local disk, a value
means an object key prefix. It is **stored, not derived**, because the owner and
the reader are not always the same tenant — a platform-owned package is read by
every org (`contentScope`), so computing the prefix from the *requesting* org
would address the wrong keys for exactly those rows. Nullable is what lets the
two drivers coexist per package instead of forcing a flag day.

**The iframe stays same-origin even on `s3`, and that is not negotiable.**
The obvious cloud-native move — hand the browser a presigned R2 URL — breaks
the player. SCORM content calls `window.parent.API.LMSSetValue(...)`, and a
frame served from `*.r2.cloudflarestorage.com` is cross-origin to the player
page, so those calls throw on property access and the package tracks nothing,
*silently*. So the bytes move to R2 while the URL does not change: the browser
requests `/scorm/<dir>/<file>`, `client/next.config.mjs` rewrites to this API,
and `ScormContentHandler` streams the object out of the bucket (§10.1 is the
same reason that rewrite exists at all). `signedAssetUrl` exists for out-of-band
use — an admin download, or confirming what was written — never for the frame.

**Path resolution moved into the drivers.** `ScormContentMiddleware` used to
reimplement `send`'s disk normalization inline. That is correct for a filesystem
and meaningless for a key space, so each driver now owns the rule for turning a
request path into the address it will actually serve, and the middleware asks
the driver. The two-interpretation trap the guard exists to close is only closed
if the authorized address and the served address are the same string — which
means the rule has to live with whatever resolves it.

`ScormRepository.findLocationByPackageDir` is **deliberately unscoped** and is
the only such method in that repository. It resolves storage location from a
UUID the middleware in front has already authorized, and it cannot be
org-scoped because the key prefix belongs to the package's owner. It returns
only the two location fields; adding a column there without re-reading its
docblock would be a leak.

**Three grains of SCORM tracking, none replacing another:**

| Table | Shape | Answers |
|---|---|---|
| `scorm_tracking` | one row per (user, package), upserted | where is the learner now — the resume record `loadFromJSON` reloads |
| `scorm_attempts` | one row per finished attempt + CMI snapshot | how did each sitting go |
| `scorm_datamodel_log` | one row per `SetValue` delta, timestamped | what did they do, in order, within a sitting |

The log is an **activity** table: `orgScope`, never `contentScope`. Its
`organization_id` and `attempt_number` are both resolved server-side — the org
from the verified JWT, the attempt from `COUNT(*) + 1` over `scorm_attempts` in
SQL — so a client can neither claim a tenant nor backdate a delta into an
earlier attempt. Writes are one multi-row `INSERT`, never one per element (§7.1
on the hottest write path in the system), and every read is paginated (§7.6) —
a single sitting emits thousands of rows.

Endpoints are mounted per audience (§2.2), not at a shared `/v1/scorm/track`:

```
POST /api/learner/scorm/:packageId/datamodel          learner writes a batch
GET  /api/learner/scorm/:packageId/datamodel          their own timeline
GET  /api/admin/scorm/:packageId/datamodel/:userId    admin reads one learner's
```

**Frontend.** `scorm-again` keeps owning `window.API` / `window.API_1484_11`;
`client/components/scorm/datamodel-recorder.js` proxies `SetValue`/`LMSSetValue`
to record deltas and flushes them on Commit, Terminate, a 20s timer and
`pagehide`. Delivery is `fetch(..., { keepalive: true })`, **not**
`navigator.sendBeacon`: a beacon is `no-cors` and so cannot carry JSON to
another origin, and `lms.edstellar.com -> lms-api.edstellar.com` is another
origin. The cost is fetch's 64 KB keepalive body cap, which is why the recorder
flushes on a timer rather than saving everything for the end. Consecutive
identical writes to one element are dropped — packages re-set `total_time` on
every tick, and the previous row's `created_at` already says when the value last
changed.

Recording never breaks the lesson: every recorder method swallows its own
errors and always calls through to the real runtime. A lost analytics row is
acceptable; a package that stops tracking its own completion is not.


**Provisional packages (migration 0010).** The lesson editor must upload the
zip *before* it can save the lesson — it needs the package id for the payload
and the manifest's declared duration to prefill the field — so the package row
and its files are committed first. Every failed or abandoned save therefore used
to leave a package nothing pointed at: ten uploads on 2026-09-04 left eight of
them, all showing in the admin SCORM library, which is precisely what made a
failed save look like a successful one.

`scorm_packages.claimed_at` fixes it:

| `claimed_at` | Meaning |
|---|---|
| NOT NULL | Real — uploaded to the library directly, or attached to a lesson that saved |
| NULL | Provisional — the lesson editor uploaded it, nothing references it yet |

- Provisional is **opt-in** (`provisional=1` on the upload), so the library page
  and any existing caller are claimed at creation and entirely unaffected.
- `CoursesService` claims the package **after** the lesson row is written, in
  both create and update. Claiming before the write would recreate the problem.
- `listPackages` hides unclaimed rows — debris is not a library entry.
- `ScormService.sweepProvisional()` deletes unclaimed packages older than
  `PROVISIONAL_TTL_MINUTES` (12 h) and their files. Triggered opportunistically
  **on upload**, not by a scheduler: no scheduler exists here, and an upload is
  both the only moment this endpoint is reached and exactly when clearing the
  previous upload's debris is worth doing. `sweepUnclaimed` is deliberately
  unscoped — it is the server tidying up after itself, and scoping it would mean
  debris in a quiet tenant was never collected.
- The 12 h threshold is the safety argument: an admin who uploads a 100 MB
  package and then spends twenty minutes on the form must not have it deleted
  underneath them. The fast path is the **client's own rollback** — the lesson
  editor deletes a package it uploaded if its save then fails, because it knows
  at once, whereas the server cannot tell a slow admin from a closed tab.

`npm run db:clean-orphan-scorm` handles the backlog and anything the sweep's
conservative threshold leaves. Dry-run by default, `--commit` to apply, matching
`db:reset-to-admin`. It cleans two classes: rows nothing references, and
directories with no row at all (invisible to the application, so only a
disk-vs-database comparison finds them). It refuses to touch a package with
tracking, attempts or data-model rows even when no lesson carries it — that
history is the record of someone's training.

### 10.11 Learning journeys

A **journey** is an ordered path of existing courses, with a badge, a points
bonus and a standalone certificate at the end. `specs/learning-journeys.md` is
the design; this section is what a maintainer needs to not break it.

**Everything is derived except `completed_at`.** `journey_enrollments` stores
who is on a journey and when they finished it, and nothing else. Percentage,
per-course status and "current step" come from `user_lesson_completions` and
the same completion definition `CertificatesService.evaluate()` already uses.
This is §10.7's lesson applied again: teach nothing new about what "complete"
means, and the dashboards, hours and leaderboard pick a journey up through
definitions that already work.

**The gate is on the assignment row, not the course.**
`user_course_assignments.source_journey_id` is what makes the owner's rule
work:

| The learner's assignment row | Gate |
|---|---|
| `source_journey_id IS NULL` — an admin assigned it directly | **open, always** |
| `source_journey_id = J` — the journey put it there | open only once every required earlier step in J is complete |

So a course is never locked *globally*; only its position inside a journey is.
An admin who assigns step 3 directly to somebody has deliberately opened it, and
the journey view shows it open. Assigning a journey uses
`ON CONFLICT (user_id, course_id) DO NOTHING`, so a pre-existing direct
assignment keeps its NULL and stays open — the journey can never take a course
away from someone who already had it.

**The lock is enforced on every content path, not just the lesson page.**
`JourneyGateService` (its own dependency-free module, so anything may import it
— including the modules `JourneysModule` itself depends on) guards all six:
the lesson read, the lesson-complete write, lesson media, video progress,
resource URLs, SCORM (`assertAccess`, the one chokepoint every learner SCORM
route already passes through) and assessment attempts. Gating only the read was
the first version, and it was worth nothing: `GET` returned 403 while `POST
.../complete` returned 200, so the whole course could be finished — hours,
certificate and journey included — by skipping the page that checked.

**A direct assignment clears the gate.** `createAssignments` /
`createAssignment` do `ON CONFLICT ... DO UPDATE SET source_journey_id = NULL`,
not `DO NOTHING`. An admin assigning a course by hand is deliberately opening
it, and with `DO NOTHING` that action silently did nothing when the journey had
already created the row.

**Completion fires from the three triggers that already exist** — lesson
complete, assessment submitted, SCORM commit — beside `autoIssue`, never on a
schedule. `JourneysService.onCourseProgress()` is best-effort throughout (§8.4):
a badge or certificate failure must not break marking a lesson complete.

**Points are not written anywhere.** `LeaderboardRepository.standings()` sums
`journeys.points_bonus` over completed enrollments as one subquery, so stamping
`completed_at` IS the award. That is what keeps §10.5's single formula true —
do not add a `points` column to an enrollment. Each journey carries its own
bonus because a 3-course path and a 12-course path are not worth the same.

**The journey certificate shares the `certificates` table**, coded
`EDS-J<journeyId>-<userId>-<hash>` so it is tellable from a course certificate
by eye. `course_id` is now nullable, with a CHECK that exactly one of
`course_id` / `journey_id` is set and a partial unique index on each. That half
was **not** additive, so it lives in `scripts/migrate-journey-certificates.mjs`
(dry-run by default, `--commit` to apply) rather than the boot migration.

**Badges are now stored, not derived.** `user_badges` records what was earned
and when. The nine badges that predate journeys were recomputed on every
request from thresholds written out three times in `learner.service.ts`, so a
badge silently un-earned whenever the underlying data moved. They now live in
`common/badges.ts` — the catalogue is code, for the same reason
`common/permissions.ts` is — with each threshold stated once, and awards
persisted. `GET /learner/achievements` keeps its original response shape.

Note `LeaderboardEntry.badges` still means "distinct assessments passed". It is
not a badge and never was; do not conflate the two.

### 10.10 Course thumbnails

A course may carry a cover picture (`courses.thumbnail_url`). It is optional
everywhere: without one, `client/components/shared/course-art.jsx` derives a
fallback illustration from the course's content, which is what the learner has
always seen.

**A session has one too, and it is the same column.** A session's picture is
stored on its companion training course (§10.7) — which IS the card the learner
sees — so there is no `sessions.thumbnail_url`, no migration, and nothing new
to render: My Courses picked it up the day the field was added, through the
definition it already uses. The admin session list reads it back off the `tc`
join it already makes. `SessionsService.syncTrainingThumbnail` is the only
writer, because `CoursesService` refuses edits to a session training.

**Local disk, not R2, and that is deliberate.** Lesson video and documents are
private per learner, so they are handed out as short-lived presigned URLs
minted per click. A thumbnail is the opposite — rendered by `next/image` on
every course card, from an optimizer that runs server-side and carries no
cookie — so its URL has to be stable and anonymously fetchable. The R2
variables are also optional (§9.1), so an R2-only thumbnail would be a dead
button in any deployment that has not configured them. The cost is the `local`
SCORM driver's cost: a second API process cannot see what this one wrote. Put
`UPLOAD_STORAGE_PATH` on shared storage before running more than one instance.

| | |
|---|---|
| Uploaded by | `POST /api/admin/media/course-thumbnail` (multipart, `upload_content`) |
| Attached by | the course save (`manage_courses`) or the session save (`manage_sessions`) |
| Stored at | `<UPLOAD_STORAGE_PATH>/course-thumbnails/<uuid>.<ext>` |
| Served at | `/uploads/course-thumbnails/<uuid>.<ext>`, `useStaticAssets`, no auth |
| Cap | `COURSE_THUMBNAIL_MAX_BYTES` — 5 MiB, a constant, not an env var |
| Formats | JPG, PNG, WebP, GIF. **Not SVG** — it can carry script, and this is our origin |

Three things are load-bearing:

- **The declared content type is not trusted.** The multipart `Content-Type` is
  written by the client, so the bytes are checked against the format's own
  magic number before anything is written into a directory this server
  publishes. Without that, an HTML file labelled `image/png` would be hosted on
  the API origin.
- **The filename is a fresh UUID on every upload**, never derived from the
  uploaded name. A caller cannot steer the write out of the directory, and a
  replacement never reuses a path — which is what lets the static handler serve
  it `immutable` with no risk of a cached URL showing the previous picture.
- **An omitted `thumbnail_url` means "leave it alone"; an explicit `null` means
  "remove it".** `CourseDto` and `SessionDto` both keep those apart (neither can
  use the shared `nullable` transform, which collapses both to null) and the
  services act on the difference. When the field collapsed, the settings form —
  which sends name, description and the publish flag — blanked the picture, so
  renaming a course deleted its thumbnail. It matters more on a session, where
  every other field IS rewritten from the form on every save.
- **The upload is guarded by `upload_content`, not by the permission that saves
  the row.** The first version used `manage_courses`, on the argument that the
  image had exactly one destination; it has two audiences now, `PermissionsGuard`
  has deliberately no "any of" form, and making an admin hold `manage_courses`
  to put a picture on a session would be surprising. `upload_content` already
  guards every other file upload here, and an upload on its own changes nothing
  — the row that references the key is saved behind `manage_courses` or
  `manage_sessions` respectively.

The stored file is dropped when it is replaced, when it is cleared, and when
the course or session is deleted — all after the row is written, all
best-effort (§8.4). A session delete is the case that needs care: the cascade
on `courses.session_id` takes the row but not the bytes, so the path is read
before the delete.
The browser also rolls back its own upload if the course then fails to save
(`DELETE /api/admin/media/course-thumbnail`), the same shape as the lesson
editor's SCORM rollback, because it is the only party that knows at once.

`GET /api/admin/courses/:id` now returns the same snake_case shape the list
does. It previously handed back the raw Drizzle row, so the page reading it saw
`undefined` for every field it named the list's way: a published course
rendered as a draft, and its edit dialog saved that back — renaming a course
quietly unpublished it.

### 10.8 Lesson content: video, SCORM, document — plus resources

A lesson has **one primary content**, and may carry any number of **supporting
resources** alongside it.

| Primary | Stored as | Duration comes from |
|---|---|---|
| video | R2 object (`lessons.video_key`) or a URL | the file's own metadata, read in the browser on upload; typed for a linked video |
| SCORM | package (`lessons.scorm_package_id`) | the manifest's LOM `typicalLearningTime`, when it declares one — **otherwise typed, and mandatory** |
| document | R2 object (`lessons.document_key`) **or** an external URL (`content_url`) | **typed, and mandatory** — a document has no runtime to read |
| quiz | the question set | n/a |

Documents are PDF, Word, PowerPoint, Excel, txt or csv (`ALLOWED_DOCUMENT_TYPES`
in `modules/media/dto/media.dto.ts`). Upload and link are equivalent options,
and every resource type offers both.

**Resources** (`lesson_resources`) are reference material: slides beside a
video, a handout beside a live session, a link to a spec. Each is an uploaded
file or an external link. They deliberately carry **no duration** and never
reach learning hours — which is what keeps exactly one number per lesson
counting.

`CoursesService.assertLessonContent` is the one place both rules live. It runs
on create and on update, against the MERGED state rather than the incoming
patch, so a partial edit cannot leave a lesson invalid. The browser checks the
same things first, so the admin hears it before pressing Save rather than as a
422 afterwards — but the API is what enforces it.

**Learning hours are unchanged by any of this (§10.4).** Video still counts
measured watch seconds, SCORM its own reported `total_time`, and everything
else — documents included — the declared duration on completion. A document
falls into "everything else" with no new code path, which is precisely why the
declared duration was made mandatory: null would silently make the lesson worth
zero hours.

Uploads use one presign endpoint (`POST /admin/media/document/presign`) for
both a primary document and a resource — the key is claimed by whichever row is
saved next. There is no `confirm` step, unlike video: the save itself calls
`MediaService.verifyUploadedDocument` (HeadObject, size cap, prefix check)
before recording a key, and there is no duration to report back, which is the
only reason video needs a second round trip.

Learners never see a storage key. A primary document is signed by
`GET /learner/lessons/:id/media`; a resource by
`GET /learner/resources/:id/url`, minted per click so an unopened resource
costs nothing and no link outlives its TTL inside a cached response. Both check
entitlement from the verified JWT in a single query (§7.1).

### 10.7 Sessions are trainings, not calendar events

A live/offline session IS a course assignment. Every row in `sessions` owns a
**companion course** — `courses.session_id` points back at the session — holding
one module and one lesson of `content_type = 'session'` whose
`duration_minutes` is the scheduled length of the sitting.

| Session event | What is written |
|---|---|
| session created / edited | training course + lesson created / kept in step |
| session given a cover picture | `courses.thumbnail_url` on that training course (§10.10) |
| learner added to roster | `user_course_assignments` row (this is the course card) |
| learner removed from roster | assignment and any completion withdrawn |
| admin marks session completed | `user_lesson_completions` for those who attended |
| session deleted | everything above, by `ON DELETE CASCADE` |

**Why a companion course rather than a parallel concept.** My Courses,
progress, the dashboards, the leaderboard, learning hours and certificates all
already read assignments and lesson completions. Teaching each of them about
sessions would have meant six new code paths and a second definition of both
"an hour of learning" and "completed" — exactly what §10.4 and §10.5 exist to
prevent. This way a session is picked up by definitions that already work.

Three rules are load-bearing:

- **Only attendance credits a learner.** `present`, `late` and `partial` earn
  the training and its hours; `absent` and `excused` do not. Completing a
  session whose attendance has never been marked is refused with a 422 rather
  than succeeding with no effect. Editing attendance afterwards moves the credit
  in **both** directions (`SessionsRepository.syncCompletions`), so a learner
  marked absent by mistake does not keep the training for good.
- **The learner cannot complete a session lesson.** `LearnerService.completeLesson`
  throws 403 for `content_type = 'session'`; otherwise any learner could POST
  their own attendance credit and hours.
- **Session trainings never auto-issue a certificate.**
  `CertificatesService.autoIssue` returns null when the completion snapshot
  carries a `sessionId`. A session's single lesson is completed *for* the
  learner, so auto-issue would mint a certificate for turning up. Admins issue
  them by hand through `issueManually()`.

`in_progress` is **derived, not stored**. `sessions.status` records only what a
human decided (created upcoming, cancelled, marked completed); the API adds
`display_status` from the scheduled start time
(`modules/sessions/session-status.util.ts`). No scheduler to run, nothing to
drift if the process is down at the moment a session begins, and no fifth value
in the column for the admin form to round-trip. A session past its end time and
still not marked completed keeps reading `in_progress` on purpose — completion
is outstanding admin work, not something the clock should close.

The course editor refuses to touch a session training (422 from
`CoursesService`): renaming it would be overwritten on the next session save,
and deleting its module or lesson — or adding a second one — would leave
"completed" unable to mean 100%. It stays visible in the admin course list,
badged, for tracking.

Migration `0005_session_trainings.sql` adds the column and backfills every
existing session, roster and completed-session attendance record as set-based
`INSERT ... SELECT`s.

### 10.6 Handing over a clean install

`npm run db:reset-to-admin` empties every table and keeps only admin accounts,
for giving an admin a system they will populate themselves. Dry-run by default;
`--commit` applies it. It refuses outright if no admin would survive.

Demo seeding is opt-in: `npm run db:seed` does nothing without `-- --confirm`.
A freshly reset production install and a new developer database are
indistinguishable from the inside, so the script asks rather than guesses.

It used to **refuse outright** once the database held any course or learner.
That refusal was removed deliberately, so a populated database can be re-seeded
without editing the script first. It now prints the counts and warns instead.
Know what that costs: the steps after the first have weaker guards and WILL
insert demo learners and courses alongside real ones, so `--confirm` is the
only thing left between a stray `npm run db:seed` — in a deploy script, or run
by habit — and fake data in front of a real admin. To start clean, reset first
rather than seeding on top:

```bash
npm run db:reset-to-admin -- --commit
npm run db:seed -- --confirm
```

`npm run db:seed-history` is the third data script and the only destructive one
that targets a SINGLE organization — see §10.12. Dry-run by default like the
other two.

Neither script touches `server/storage/scorm/`, `server/storage/uploads/` or
the R2 bucket — extracted packages, uploaded videos and course thumbnails
outlive a database wipe and must be cleared separately.

### 10.5 Leaderboard

`modules/leaderboard` owns the single ranking, read by both portals. Points are
`lessons x 10 + DISTINCT assessments passed x 50`, over active learners only.

Two things are load-bearing and were previously wrong: passes are counted
`DISTINCT` (counting rows let a learner farm points by re-taking an assessment
they had already passed), and `is_active = 1` is filtered (deactivated learners
kept competing, while the dashboard's own user count already excluded them).

The admin board shows hours and completion as columns but does NOT rank on them
— it used to rank on a 60/40 blend, so the two boards could disagree about who
was first. Do not add a second points calculation.

### 10.4 Learning hours

`modules/learning-hours` owns the single definition of an hour of learning, and
both portals read it. Exactly one source counts per lesson, which is what stops
a sitting being paid for twice.

**A lesson is worth its declared `duration_minutes`.** That is the rule, and
everything else follows from it:

| | While the lesson is INCOMPLETE | Once it is COMPLETE |
|---|---|---|
| uploaded video | measured watch seconds, **capped** at `duration_minutes` | `duration_minutes` |
| SCORM lesson | `total_time` reported by the package, **capped** at `duration_minutes` | `duration_minutes` |
| session / document / quiz | nothing | `duration_minutes` |
| standalone SCORM (assigned, in no lesson) | `total_time`, capped at `scorm_packages.duration_minutes` when the manifest declared one | same — there is no lesson to complete |

Three consequences, all deliberate, decided with the product owner on
2026-09-08:

1. **A 30-minute course is worth 30 minutes.** Finishing it in five does not
   reduce it to five. Measured time is a *proxy* used only while the learner has
   not finished, never the payment.
2. **The declared duration is a ceiling as well as a floor.** Watching 45
   minutes of a 30-minute video earns 30. Hours stay comparable between
   learners, and a slow connection or a paused tab cannot inflate them.
3. **Re-watching earns nothing.** Once a lesson is complete its contribution is
   fixed at the declared duration, so opening it again adds no hours. This is
   what the "incomplete / complete" split above is for — not a special case.

This replaced an earlier rule where video counted *only* measured watch seconds
and SCORM *only* its reported `total_time`. Both under-credited real work: a
30-minute video skimmed in five paid five, and a SCORM package that reported
`PT0S` paid nothing even when it reported itself completed — which was
observable in the seeded data on package 24 / lesson 47.

Because SCORM lessons are now credited by completion like anything else, a
SCORM lesson's `duration_minutes` is load-bearing, which is why §10.8 makes it
mandatory. A standalone SCORM assignment has no lesson and therefore no
declared duration unless the manifest supplied one; it is the one case that
still relies on reported time alone.

Do not add a second place that sums hours. The learner view and the admin
analytics previously computed them independently — the admin side counted no
SCORM at all — and the same learner read differently depending on who looked.

There are two shapes of the same figure: `minutesByUser()` (per learner, with
monthly and weekly buckets) and `minutesByUserAndCourse()` (per learner per
course, for the exported report's "Time Spent" column). Both are built from one
`lessonSource` SQL fragment in the repository, so the per-course rows always sum
to the per-learner total — writing the second query by hand is exactly how they
would come to disagree.

**Migration complete — 85 handlers, all on the server.**

`client/app/api/` no longer exists. The frontend has no database driver, no
schema, no JWT secret and no database credentials; its only configuration is
`NEXT_PUBLIC_SERVER_URL`. Identity comes from `GET /api/auth/me` via
`client/lib/session.js`, so the server is the single authority on who a caller
is.

### 10.1 SCORM content serving

Extracted packages live in `server/storage/scorm/` and are served by
`useStaticAssets` at `/scorm/<uuid>/...` (outside the `/api` prefix).

The client **proxies** that path via a rewrite in `client/next.config.mjs`
rather than pointing the player's iframe straight at the API. SCORM content
calls `window.parent.API.LMSSetValue(...)`, and the same-origin policy blocks a
cross-origin iframe from reaching the parent's JavaScript — so the bytes come
from the server while the URL stays same-origin with the player. `/scorm` is
also excluded from the middleware matcher, or those iframe requests would be
redirected to `/login`.

`scorm-again` remains a **client** dependency (it runs in the browser);
`adm-zip` and `fast-xml-parser` moved to the server with the upload handler.

### 10.2 Fixed while migrating

Bugs found in the legacy handlers and corrected in the port — worth knowing if
you compare old and new behaviour:

- **Attendance `marked_by` was always null.** The legacy handler wrote
  `payload.id`, but the JWT claim is `userId`, so the marker was never recorded
  and the "marked by" name never rendered. Now stores the real admin id.
- **Bulk option inserts** in the assessment builder ran one round trip per
  option; they are single statements now.
- **Department bulk-enrolment** selected matching learners and inserted them in
  a loop; it is now one `INSERT … SELECT`.

### 10.3 Known follow-ups

- `listForAdmin` (admin certificates) is unbounded — add pagination (§7.6)
  before the certificate count grows.
- ~~SCORM storage is behind `SCORM_STORAGE_DRIVER`; the S3/R2 driver is not
  written yet.~~ **Done — see §10.9.** Remaining: no backfill exists for
  packages already on local disk, so flipping an existing deployment to `s3`
  strands them (`storage_prefix IS NULL` serves 404 under the `s3` handler).
  Write a one-off script that re-uploads those directories and sets the prefix
  before flipping the switch in production.
- `TokenService` can move to `@nestjs/jwt` once §10 reaches zero pending
  modules and the legacy verifier is deleted (§6.4).
- Rate-limit the public verify endpoint (`@nestjs/throttler`).
- Add `helmet` for security headers.

---

## 11. Adding a new module — checklist

Answer these before writing code:

- [ ] Which audiences does it serve? One controller per audience (§2.2).
- [ ] Is every route's access explicit — `@Public`, `@Roles`, or authenticated-by-default (§5.2)?
- [ ] Is ownership checked in the service, returning 403 vs 404 correctly (§5.3)?
- [ ] Does every query live in a repository, with an explicit column list (§3.1)?
- [ ] Is there any loop containing an `await` on a query? Collapse it (§7.1).
- [ ] Does every filtered/joined column have an index, in both schema and migration (§6.3, §7.4)?
- [ ] Are all list endpoints paginated (§7.6)?
- [ ] Is input validated by a DTO with `class-validator`?
- [ ] Does any free-text field need a length cap? A `description` always
      does — `DESCRIPTION_MAX_LENGTH` from `common/content-limits.ts`,
      never a number typed into the DTO (§8.5).
- [ ] Are the status codes right (§8.2), and does the envelope match (§8.1)?
- [ ] Does any response contain PII the caller should not see?
- [ ] Are secrets read only through `ConfigService` (§9)?
- [ ] Is the migration ledger updated (§10)?
