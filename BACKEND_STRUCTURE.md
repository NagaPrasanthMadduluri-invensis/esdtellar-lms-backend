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
CORS (main.ts)                  exact CLIENT_ORIGIN(s) + credentials:true
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
| `CLIENT_ORIGIN` | no | Exact frontend origin(s) for CORS — comma-separated, no wildcard. The FIRST is canonical and is what email links are built from |
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
| `EMAIL_ENABLED` | no (`false`) | Master switch. False writes no outbox rows at all |
| `EMAIL_DRIVER` | no (`log`) | `log` · `file` · `ses` · `gmail`. **Production runs `gmail`** |
| `EMAIL_FROM` / `EMAIL_FROM_NAME` / `EMAIL_REPLY_TO` | for sending | The envelope. `spectralms@edstellar.com` in production |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | for `gmail` | OAuth. The refresh token expires in 7 days while the consent screen is in "Testing" |
| `GMAIL_SERVICE_ACCOUNT_KEY` | alternative | Domain-wide delegation instead of a refresh token — does not expire |
| `SES_REGION` / `SES_CONFIGURATION_SET` | for `ses` | Built, not in use |
| `EMAIL_RATE_PER_SECOND` | no (1) | Worker pacing. One send, then sleep |
| `EMAIL_MAX_PER_DAY` | no (200) | **2000 in production** — which is Gmail's own Workspace ceiling, so there is no headroom left |
| `EMAIL_BATCH_SIZE` | no (25) | Rows claimed per drain tick |
| `EMAIL_ALLOWLIST` | no (empty) | Comma-separated. Non-empty = a dry run: every other row is written `suppressed/not_allowlisted` and counted. **Empty in production — real learners are emailed** |
| `EMAIL_MAX_RECIPIENTS_PER_NOTIFY` | no (200) | One notification above this is SKIPPED, not truncated |

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
| platform service queue (cross-tenant, respond) | 3 | `server/src/modules/services` |
| tenant directory + access control (platform) | 3 | `server/src/modules/organizations` |
| billing — invoices and payments (platform) | 7 | `server/src/modules/billing` |
| seats — limit, usage, requests (tenant + platform) | 6 | `server/src/modules/seats` |
| notifications (the bell, every portal) | 3 | `server/src/modules/notifications` |
| geo reference data (countries, cities, industries) | 3 | `server/src/modules/geo` |
| org workforce options (branch locations, job levels) | 4 | `server/src/modules/org-options` |
| session feedback (learner writes, trainer reads anonymised) | 3 | `server/src/modules/feedback` |
| course feedback — editable templates + learner answers | 8 | `server/src/modules/surveys` |
| course catalogue — self-enrolment in courses and sessions | 4 | `server/src/modules/catalogue` |
| external certifications (learner claim, manager + admin approval) | 6 | `server/src/modules/external-certifications` |
| email (outbox, preferences, unsubscribe, SES events, platform read) | 7 | `server/src/modules/email` |
| forgot password (request, check, reset) | 3 | `server/src/modules/auth` |
| scheduled reminders (`course_due_soon`) — cron, no HTTP | 0 | `server/src/modules/reminders` |

### 10.32 An audit log, and an admin who can see their own email

Two features from one complaint: an admin bulk-imported 300 learners and
had no way to find out whether any of them had been emailed. None had
(§10.31 records that gap). Neither half of the answer existed — nothing
recorded what people did, and the only delivery read in the product was
`@PlatformAdmin()` with no UI.

#### `audit_log`, and why it is not `activity_log`

`0043_audit_log.sql`. Read its header first; the summary:

**§10.12 told us to.** It says, of `activity_log`: *"this is a product
feature, not an audit trail — the entries that are missing are precisely
the ones whose write failed. If a real audit trail is needed it is a
different table with different guarantees; do not quietly promote this
one."* This is that sentence being acted on rather than argued with.
`activity_log` keeps its job — 21 curated types, hand-written where a
service has something a human wants to read, feeding the dashboard panel.
Pouring every CRUD request into it would bury "Course published" under ten
thousand rows.

**ONE middleware writes it, and that is the whole design.** Not 200 call
sites. §5.2.1's rule — a permission with no guard behind it is a screen
that lies — has an exact analogue here and it is worse, because a missing
audit row is invisible: the thing absent is a row nobody wrote. An endpoint
added next year is covered the day it is written, with nobody remembering
anything.

**It is MIDDLEWARE, not an interceptor, and testing is what caught that.**
The first version was a `NestInterceptor`, which is the obvious choice and
wrong: **Nest runs guards BEFORE interceptors**, so a request refused by
`RolesGuard`, `PermissionsGuard` or `PlatformAdminGuard` never reaches one.
Measured — a tenant admin POSTing to a `@PlatformAdmin()` route got its 403
and wrote no row at all, and a 404 from the router was invisible for the
same reason. That is not an edge, it is half the point: *"who tried to
reach billing"* is exactly what an audit log is opened for, and a log of
successes cannot answer it. Middleware runs ahead of every guard and
records on `res.on('finish')`, so it sees the response whatever produced
it. By then `request.user` and `request.route` are populated, so the late
read costs nothing and gains the refusals.

**What it does not promise.** The row is written after the response, not
inside the handler's transaction — an interceptor cannot enlist in a
transaction a service has already committed, and neither can this. A crash
in that gap loses the entry. Far narrower than best-effort (the write is
retried once and a failure logs at `error`, not `warn`), and NOT
"transactionally guaranteed". Anybody relying on this in a dispute should
know which of those two sentences is true.

**The body is captured BEFORE the handler runs**, because the global
ValidationPipe transforms `request.body` in place and a service may mutate
it further — reading it in the finish handler can record something the
caller never sent, which is the one thing an audit log must not do.

**Credentials are never stored.** Three routes carry a password, the bulk
import carries up to 500, and two more carry a reset token. The redaction
is a SUBSTRING test on the lower-cased key, so `newPassword`,
`current_password` and `passwordHash` are all caught without being listed.
Arrays are truncated with the COUNT kept — "500 rows" is precisely the fact
somebody auditing an import wants, and a copy of the spreadsheet is not.

**A LOGIN is attributed, succeeded or refused**, and getting there needed
one deliberate addition. The route is `@Public()`, so `AuthGuard` populates
no user and the first rows read "Unauthenticated" with a NULL
organization — which the org-scoped read then excluded, so a tenant could
not see its own sign-ins at all. `AuthService.auditActorFor()` resolves the
address BEFORE the attempt, so a WRONG PASSWORD is attributed to the right
person and the right org: *"somebody tried to sign in as Priya and failed"*
is the row that matters. **The response is unchanged** — all three outcomes
still return one indistinguishable 401 (§5.3), and the lookup reaches only
`audit_log`. It uses a new `findIdentityByEmail`, deliberately not
`findActiveByEmailWithSecret`: that method is named `...WithSecret` so the
one place a scrypt hash enters scope is obvious (§3.1), and pulling a
credential in to write a log line would make the naming a lie.

**`entity` is anchored on the ID, not the last segment.** The first version
took the last non-numeric segment and filed `/lessons/1/complete` under an
entity called "complete" — a verb, which groups nothing. The rule is now:
find the last numeric segment, that is the id, and the one before it is the
collection. The verb is not lost; `route` still carries the pattern.

**`view_reports`, not a new `view_activity`.** §10.24 states the rule this
follows: a dedicated permission needs a grant migration, and every one of
those bumps `perm_version` and signs every user in every organization out
once. Nobody has asked for an admin who may read reports but not the
activity log, and `view_reports` already gates "the evidence". When an
organization wants that separation, that is the moment to pay for it.

Two controllers, per §2.2 and §10.17 — a second one ADDED, never the
tenant's widened:

```
GET /api/admin/activity[/options]      the caller's own org   (view_reports)
GET /api/platform/activity[/options]   every tenant           (@PlatformAdmin)
```

Cross-tenant reach is a property of **which class answered**: the tenant
controller hands `scope.organizationId` to the service and the platform one
hands `null`. `organization_id` on the query narrows the platform read and
is ignored entirely by the admin one, so the same query string against the
tenant route changes nothing.

Two high-volume telemetry writes are skipped on purpose — the SCORM
data-model log (§10.9 calls it the hottest write path in the system) and
video progress. One row per batch would bury every human action, which is a
worse outcome than not recording a telemetry write. **The page says so in
words**, because an audit log that quietly omits a class of event is worse
than one that states what it omits.

#### The tenant can finally see its own email

```
GET  /api/admin/email/outbox              (view_employees)
POST /api/admin/email/outbox/:id/resend   (manage_users), 200 not 201
```

A second repository method beside `listForPlatform`, never that one gaining
an optional org id: the two answer different questions and the difference
is a tenancy boundary, which an `undefined` away is not a boundary at all.

**`sent` means Gmail ACCEPTED it, and the UI says "Handed to Gmail".** The
bounce and complaint loop (`POST /api/email/ses-events`) is SES-specific
and is not wired for Gmail, so nothing after acceptance reaches this table.
Printing "Delivered" would be the screen that lies about the one subject
where an admin has no other way to check. Wiring Gmail's own bounce
handling is the change that would let this say more.

**Resend is offered only for a `failed` row**, and the predicate enforces
it rather than the button: a `sent` row would deliver a duplicate nobody
can recall, and a `suppressed` one was withheld on purpose — re-queuing it
walks past an unsubscribe or a bounce. `attempts` is reset, because the
five tries were spent on a condition a human has since looked at; leaving
them would make the button appear to do nothing. A row belonging to another
tenant 404s exactly as a non-existent one does, or the id becomes a probe
for how much mail another organization sends.

**`email_delivery_failed` is `email: 'none'`, and that is the loop guard
rather than a preference.** It fires precisely when sending is broken; if
the cause is the transport rather than one address, emailing the alert
enqueues a message through the machinery that has just failed — which
fails, and alerts, and enqueues. An outbox that fills itself is worse than
the failure it reports.

**The alert is a SWEEP, not a line in the drain job**, and the reason is
the module graph: `NotificationsModule` imports `EmailModule` (that is what
gave `notify()` its second channel, §10.30), so `EmailModule` importing
notifications back is a cycle. `forwardRef` would compile and would make
the two permanently inseparable for a feature that does not need it.
`EmailFailureAlertsService` lives in `RemindersModule` — already the home
of scheduled, controller-less, worker-only work — which keeps the graph a
DAG: `Worker -> Reminders -> { Notifications, Email }`. Hourly at :20, off
the hour because the drain runs every minute on a 2-vCPU box shared with
two other applications. Dedupe is `notifyOnce()` keyed on the outbox row
id, §10.18's shape for anything recomputed — so the sweep may re-read its
window freely and no new column was needed to remember.

### 10.31 The bulk import learned a reporting line

`users.manager_id` has existed since `0033`, and the only way to set it was
the Add User form one person at a time — so an admin onboarding forty people
from a spreadsheet got forty learners with no manager and no Team Learning
for anybody above them. **No migration, no new endpoint, no new permission:**
one optional column on `BulkUserRowDto`, one repository read, and a column in
the template.

**The file carries an EMAIL; the browser shows a NAME.** A spreadsheet cannot
hold a `users.id`, and two people in one organization can share a name — a
name column would attach somebody's reports to the wrong Priya and say nothing
about it. An address is the login identity and is unique. So the admin types
the unambiguous thing and the upload preview resolves it back to the human one
before anything is written, which is where a wrong address is actually
noticed. The template's instruction row says EMAIL ADDRESS in those words,
because it is the one column whose heading does not explain itself.

**`activeByEmails` is ONE query for the whole file** (§7.1), keyed by the
distinct addresses in it: a 500-row upload naming forty managers costs one
round trip, not five hundred. `organization_id` is in the predicate, so an
address belonging to another tenant resolves to nothing at all — the manager
column cannot become a cross-tenant write through a spreadsheet, and the
caller cannot tell "no such person" from "not yours". ACTIVE only, matching
the picker in the Add User form: a deactivated account cannot sign in to read
Team Learning, so pointing reports at one records a line nobody can follow.

**Blank is a valid row and always will be.** Most learners have no manager
recorded, and an import that refused them would be an import nobody could use.

**An address that resolves to nobody FAILS the row**, with the reason naming
it. The admin typed it, so it was meant; importing the learner without it
would leave somebody their manager cannot see, discovered weeks later by the
manager wondering where their report went. Same instinct as the location and
job-level checks beside it — name what is wrong while the CSV is still open.

**A person created by the file can be named as a manager by a row BELOW
them**, which is how a team is onboarded in one upload: each successful insert
is added to the lookup. A cycle is impossible by CONSTRUCTION rather than by a
check — a manager must already exist at the moment their report's row is
processed, and rows are processed in order, so a pair naming each other simply
fails the first row and then the second. That is why `assertManager`'s walk is
not needed here; self-reference still is, and is refused with its own
sentence.

Verified through the real admin UI with a six-row file: 4 created, 2 failed,
and the two reporting lines (one to an existing manager, one to a learner
created three rows earlier) confirmed in the database.

**Known and NOT fixed here: a bulk-created learner gets no welcome email.**
`UsersService.create` calls `passwordReset.sendWelcome`; `bulkCreate` does
not, so forty imported learners hold `DEFAULT_BULK_PASSWORD` and have no way
to learn it. Measured — zero outbox rows for the four created above. It is
left out deliberately rather than overlooked: a 500-row import is a 500-email
fan-out, which is a decision about volume and timing (§10.30), not a line to
add quietly to a loop.

### 10.27 What KIND of learning an hour came from

My Progress splits a learner's hours three ways — courses, learning paths,
sessions — and the split is **a partition of the number §10.4 already
defines**, never a second count beside it.

**Three kinds, and the precedence is the whole design.**
`LearningHoursRepository.learningTypeExpr` states it once:

```
session -> the course is a session's companion training (§10.7)
path    -> the LEARNER'S ASSIGNMENT ROW was written by a journey
           (user_course_assignments.source_journey_id, §10.11)
course  -> everything else, including an approved external
           certification (§10.26)
```

Exclusive and exhaustive, so the three sum to the learner's total and the
stacked chart cannot disagree with the tile above it. Verified across six
learners: every yearly row adds up, and the by-year totals reconcile with
`summary.allTimeHours`.

**The middle branch reads the ASSIGNMENT, not the course.** A course is not
intrinsically "path learning" — it is path learning for the learner a journey
put it in front of, and the same course assigned directly to somebody else is
a plain course for them. Keying off the course would have made one learner's
history rewrite another's.

**There is deliberately NO webinar branch.** `sessions.session_type` accepts
`ILT` and `Virtual` only, so a webinar bucket would be zero on every row for
every learner in every tenant — the empty-column failure §10.12 records. The
reference design shows four series; three are built. The colour is reserved in
`globals.css` and `lib/brand.js` so the day the enum gains Webinar the branch
is one line and the hue is already decided.

**Learning paths currently total zero everywhere, and that is DATA, not a
gap.** `journeys` holds no rows in any environment yet, so the tab and the
column are honestly empty and the empty state says an admin builds these from
existing courses. That is the difference worth keeping straight: the webinar
column *cannot* be non-zero, the paths column *is not yet*.

**The SCORM residual is folded in, not left out.** `minutesByUser` is lesson
minutes PLUS reported time for packages no lesson completion has paid for, so
a breakdown built from the lesson half alone would sit quietly short of the
headline beside it. `learnerScormByType` carries the same three predicates as
`scormTimesByCourse`, and `credited_by_lesson` is still applied in the service
because `total_time` is a string in one of two formats Postgres cannot sum.
Its bucket is derived in JS from `updated_at`, and `truncateIso` is ISO
(Monday-first) to match `date_trunc('week')` — a Sunday-first week would put
the two halves of one sitting in different bars.

**Four granularities, TWO units queried.** Quarters and years are folded from
the monthly rows, never re-truncated in SQL — §10.12 records why for the admin
axis and the reason is unchanged: four `date_trunc` variants are four chances
for a quarter to disagree with the sum of its own months. Weeks straddle
months and so are genuinely their own unit. The axis is continuous and
zero-filled between first and last activity, then capped, because a series
shorter than its axis shifts every remaining point one place left.

**Rounding: the row adds up, and the reason is who can check it.** Hours are
shown to one decimal, and rounding four numbers independently breaks the
visible arithmetic about a third of the time. `periodHours` therefore rounds
the TOTAL correctly and apportions the three parts to it by largest
remainder. What that cannot fix — and nothing can — is that two
correctly-rounded years may sum 0.1 away from the correctly-rounded all-time
figure. The arithmetic a reader can actually see wins.

**One definition of the monthly goal.** `goalStatus()` in `learner.service.ts`
returns `goal`, `goalPct`, `remaining` and `statusLabel`, and both My Progress
and the Learning Hours page read it. They each had their own before; the two
screens sit one click apart and would have disagreed about whether somebody
was "Almost There" the moment a threshold moved.

**No new endpoint and no new permission.** `GET /api/learner/progress` grew
`learningHistory`, `hoursByPeriod` and `hoursByYear`. The paths tab reads
`JourneysService.listForLearner` — the module, never its repository (§3.2) —
so what My Progress says about a path cannot disagree with the Learning Paths
page itself.

### 10.28 The learner's learning paths got a screen

Eleven journey handlers have existed since §10.11 and the learner had no page
for any of them — `GET /learner/journeys` and `GET /learner/journeys/:id` were
reachable and unreached, which is §5.2.1's screen-that-lies seen from the
other side. `/learning-paths` is that screen. **No new endpoint, no new
permission, no migration** — both reads were widened instead.

**`listForLearner` also carries the ORDERED COURSES of every path**, so the
card can draw its sequence. `compactStepsForJourneys` fetches them for all
the paths on the page in ONE query keyed by the id list — calling
`getJourneySteps` per card would be six round trips to draw six cards, the
N+1 §7.1 forbids. It returns only what a chip needs, and derives its state
through the same `stepProgressStatus` the detail uses, so a chip and the step
card it links to cannot disagree.

**A STEP MUST BE COMPLETABLE BY WALKING THE PATH**, and `setCourses` now
refuses the two kinds of course that are not. A session's companion training
is completed by attendance (§10.7), which needs a `session_roster` row that
only `addToRoster` writes — but `assignJourneyCourses` inserts the assignment
directly, so a learner put on such a path who is not separately booked onto
the session has a step they can never finish and a path that can never
complete. An external certification is already finished the moment it is
approved (§10.26).

Neither has ever been offered by the admin Course Library the picker reads
(§10.3.1.17, §10.26), so this closes a gap between what the UI shows and what
the API accepted — §10.3.1.9 states the same rule for Assign Learning, and
this is that rule arriving late. Found because a real path in the live
database contained one. The 422 NAMES the courses and says to remove them,
because an existing path holding one cannot be saved again until it does.

**`journeyPct` was removed from `GET /learner/courses`.** It was the share of
assigned courses completed, rendered as a "Learning Journey" percentage on a
My Courses tab that numbered an arbitrary list 1..N — a bundle presented as a
sequence, with no relation to `journeys` at all. Two things called a journey,
one of them not one, is how a learner stops trusting either. Nothing else
read the field.

**`getJourneySteps` gained what a step CARD has to say**: duration, lessons
done over total, best score, pass flag and the learner's due date, as
correlated subqueries in the one statement (§7.1). A twelve-course path would
otherwise cost 48 round trips to draw one screen.

**`progress_status` is a SECOND field beside `status`, not a replacement.**
`status` is the gate — locked / open / complete — and is what enforcement
reads. It deliberately cannot tell "untouched" from "half finished", because
the gate does not care. A card does. Keeping them apart matters more than the
duplication saves: merged, the next caller would gate on a progress figure,
and the gate is the thing that must not be re-derived.

`stepProgressStatus` will not call a course FAILED for an outstanding quiz.
Only an actual unsuccessful attempt earns it — the completion definition
already requires the pass (§10.11), and calling a not-yet-attempted assessment
a failure accuses somebody of something they have not done.

**`listForLearner` gained the card's three counts and its total length**, again
as correlated subqueries rather than a query per card. They count EVERY course
in the path, while `total_required` / `completed_required` beside them keep
counting only the required ones — two different questions, and a card that
said "5 courses" above six chips would be the two-numbers failure.

"In progress" is expressed as *not complete AND at least one lesson done*,
which is the same shape `LearnerService.progress` uses for a course. One
definition of "started", read in two places.

**The detail response carries the ENROLMENT's dates**, not the journey's —
when THIS learner was put on it and when THEY have to finish. The list card
already showed both and a detail view that dropped them read as though the
dates had been withdrawn.

**Verified end to end against a real path** created through the admin API
(4 courses, 2 learners) rather than written into the tables: the counts summed,
the gate produced a genuinely locked step for the learner who had not been
assigned the earlier courses directly, and a learner who HAD one of them
directly saw it open out of order — which is §10.11's rule working, not a bug.
The fixture was removed afterwards and `journeys`, `journey_courses` and
`journey_enrollments` are back to zero rows.

### 10.30 Email, a worker, and the first scheduler

`0037_email_outbox.sql` gives the product transactional email. Read the
migration header first; the summary:

**THE OUTBOX IS THE MESSAGE STORE AND pg-boss IS THE CLOCK.** That inversion
is the central decision and it is the one somebody will try to "fix".
Enqueuing a pg-boss job per email would be a dual write — the notification
transaction can commit with the job lost, or roll back with the job queued —
and neither is detectable afterwards. A row in the same database cannot have
that problem. What pg-boss buys is cron, a `singletonKey` so a second worker
cannot drain concurrently, and retry for the tick itself.

**Postgres rather than the Redis already on the box.** That Redis is
configured as a cache — `appendonly no`, no save points — so every queued job
is lost on restart, and fixing it means changing the durability profile of
infrastructure the Rails and Laravel apps share. Postgres is already durable
and already here. Verified before building: the DB role has `CREATE`, so
pg-boss can make its own schema.

**`notify()` gained a second channel and NOT ONE of the 25 call sites
changed.** `NotificationsService.notify` writes the bell rows, then calls
`EmailOutboxService.enqueue`. The two have SEPARATE try/catches, which is the
point rather than tidiness: folding the email into the existing handler made
an email failure log "Notification not sent", which is false and sends
whoever reads it to the wrong file. And if the bell insert fails the email is
still attempted — they are independent channels.

**Whether a type emails lives in the catalogue**, as
`email: 'transactional' | 'announcement' | 'none'` on all 25 entries.
`NOTIFICATION_TYPES` is `as const satisfies Record<...>`, so a 26th type is a
COMPILE ERROR until somebody decides. A parallel `email-policy.ts` would be
free to drift and would throw that check away. It is not a boolean because
"does it email" and "may the recipient refuse it" have different answers and
different legal consequences.

**Five types are `announcement`** — the two self-enrolment openings, badges,
leaderboard rank and manager nudge. Those additionally require
`organizations.email_announcements`, which **defaults to 0**. That default is
the single thing between the first deploy and 500 unsolicited emails:
announcements go to a tenant's whole active learner population, which is
defensible under PECR as B2B mail and is still the message most likely to
draw a spam complaint — and a complaint degrades deliverability for the other
24 types.

**Preferences are three levers, not a 100-cell matrix.** `all_off` honoured
for everything (partial honouring makes the checkbox a lie, and §10.18's
guarantee that nothing here is the only way somebody learns something is what
makes that affordable); `groups_off` keyed by the catalogue's GROUP so a 26th
type needs no UI change; and a global suppression list that outranks both.
The one exception is `password_reset`, which ignores `all_off` — there is no
screen to check when you cannot sign in, so honouring it would turn a
preference into a lockout.

**`to_email` and `org_name` are frozen at enqueue**, the same reasoning that
denormalises `actor_name`. Joining to `users.email` at send time retargets
queued mail when somebody corrects their address, and leaves the delivery log
unable to say where the message actually went.

**One layout, not 26 templates.** The title and body were already composed at
write time by the service holding the course and the actor. A template per
type would re-derive that wording minutes later in a different process, from
data that may since have been renamed — exactly what the denormalised columns
exist to prevent. The layout is tables and inline hexes because Gmail strips
`<style>` and Outlook renders through Word; `email-brand.ts` is a THIRD copy
of the palette for that reason, and moves with `globals.css` like
`lib/brand.js` does.

**FOUR mailer drivers, and `gmail` is the one that runs.** `log` (the
default), `file` (writes `.eml`), `ses` and `gmail`, mirroring
`SCORM_STORAGE_DRIVER` so the whole feature is exercisable with no account
anywhere. Production and development both set `EMAIL_DRIVER=gmail`, sending
as `spectralms@edstellar.com` over the Gmail API.

`specs/email-and-queue.md` locked SES and the owner then supplied Gmail
credentials instead; the SES driver is built, tested and **not in use**. The
architecture around it did not change — outbox as the message store, pg-boss
as the clock, a separate worker, the same three retry shapes.

**The consequence worth knowing is the feedback loop.** SESv2 returns a
`MessageId` that SNS bounce and complaint events correlate on, which is what
`POST /api/email/ses-events` consumes and what fills the suppression list.
**Gmail gives us none of that**, so that endpoint is dead under this driver
and `sent` means Gmail ACCEPTED the message — not that it arrived. §10.32
records why the admin page therefore says "Handed to Gmail" and never
"Delivered". Wiring Gmail's own bounce handling is the open work, and until
it exists the suppression list only ever grows by hand.

Gmail auth is a refresh token (`scripts/gmail-authorize.mjs`) or a service
account with domain-wide delegation. **The refresh token expires after SEVEN
DAYS while the OAuth consent screen is in "Testing"** — the single likeliest
way this integration fails quietly, and `npm run email:verify` warns about it
on every run.

**Throttling is not a message failure.** A `ThrottlingException` returns the
row to `pending` WITHOUT consuming an attempt; counting it would burn a good
row's five tries on our own pacing. `attempts` increments at CLAIM, not at
failure, so a row that repeatedly kills the worker eventually gives up.
Delivery is at-least-once — a crash between SES accepting and the status
UPDATE yields one duplicate, and exactly-once email does not exist.

**`CLIENT_ORIGIN` defaults to localhost, and the worker refuses to send under
it** when the driver is `ses`. Every `link` is relative; a wrong origin means
a fan-out whose every link is dead, and an email cannot be recalled. Sending
nothing is recoverable.

#### The worker, and the first scheduler this codebase has had

`WORKER=1` makes `main.ts` fork into `worker.ts` before any HTTP setup runs.
It uses `createApplicationContext`, so **no Express instance is ever
created** — that is the real answer to "no HTTP listener". `WorkerModule`
imports config, database, email and reminders, deliberately NOT `AppModule`,
which would drag in 28 feature modules and four global guards it can never
reach. `PgBossService` is provided only there, so the API cannot start a
consumer — structural, not a convention.

**`runMigrations` gained an advisory lock in the same change, and it is an
independent bug fix.** Two processes now boot the same `DatabaseModule`, and
"idempotent" is not "concurrency-safe": concurrent `CREATE TABLE IF NOT
EXISTS` can collide on `pg_type` and two `CREATE INDEX IF NOT EXISTS` on one
relation can deadlock.

**`course_due_soon` fires at last.** It has been in the catalogue since 0030
with zero call sites, because firing it needed a clock — the gap §10.12 and
six other places record. `RemindersService` sweeps daily at 09:00 UTC at
three discrete windows (7, 3, 1 days), not every day inside a week, which
would be five emails about one course. "Not finished" means what it means
everywhere else — every assigned active lesson complete — so the sweep cannot
nag somebody who has finished, and a course with no lessons is excluded
because there is nothing they could do. Dedupe reads the `notifications` rows
the last run wrote rather than keeping its own flag.

Measured: a learner with an unfinished course due in 3 days got exactly one
reminder; the immediately-following run reported `{sent: 0, skipped: 1}`.

#### Forgot password

Three `@Public()` routes, and the product's first account recovery that does
not involve an admin reading a password out loud (§10.3.1.11 records why that
field is unmasked).

**The request route never says whether the address exists** — one sentence,
always 200, including when the rate limit is hit and when the send fails.
§5.3 states the rule for login and this is the same oracle with a friendlier
label; "no account with that email" is exactly what a well-meaning form shows
and is a free membership check.

**The database stores a SHA-256 of the token, never the token.** SHA-256 and
not scrypt deliberately: the token is 32 random bytes, so slowness buys
nothing, and the lookup has to be a single indexed query. Issuing a new token
invalidates every outstanding one for that user. A successful reset bumps
`perm_version`, ending every session — somebody resetting a password they
believe was compromised, and finding the attacker still signed in, has gained
nothing.

**Three refusals, three sentences** — not found, already used, expired —
because the useful next step differs. The page checks the link BEFORE
offering the form, so an expired link is not discovered after typing a
password twice.

```
POST /api/auth/forgot-password        always 200, always the same sentence
GET  /api/auth/reset-password/check   so the page can refuse before the form
POST /api/auth/reset-password         sets it, ends every session

GET/PATCH /api/auth/email-preferences    the caller's own, no id parameter
GET/POST  /api/email/unsubscribe         @Public, HMAC token, RFC 8058
POST      /api/email/ses-events          @Public, SNS signature VERIFIED
GET       /api/platform/email/outbox     @PlatformAdmin, read-only
```

**The SNS endpoint verifies Amazon's signature before reading the body.** It
is public and it writes to the suppression list, so unverified it is a
denial-of-service primitive — anyone finding the URL could suppress every
admin's address. The certificate URL is attacker-controlled input and is
checked against `sns.<region>.amazonaws.com` over https before it is
fetched. Subscription confirmations are logged and NOT auto-confirmed: the
signature proves Amazon sent it, not that we created the topic.

**No new permission.** The preference routes carry neither `@Roles()` nor
`@Permissions()` — all four audiences get email, so gating to one would give
three of them a control that 403s, and your own settings are not a capability
an organization grants. No route takes a user id.

### 10.29 One scale for "how close to the goal", and a goal per period

The Learning Hours page is period-driven — weekly, monthly, quarterly,
yearly — and every figure on it is scored on **one** set of bands.

**Three vocabularies became one.** The summary said "Almost There" at 80%, a
peer row said "Close" at 60%, and a third place said nothing at all. Three
scales on one page is how a learner concludes the page is guessing.
`goalBand()` in `learner.service.ts` is now the only place the thresholds
exist — 100 / 80 / 50 — and `goalStatus(hours, goal)` takes the goal as a
parameter, because the period it measures is not always a month.

**The goal is defined MONTHLY and every other period derives from it.**
`PERIOD_MONTHS`: a quarter is three of it, a year twelve, and a week is
`12/52` of it — the one conversion that is not a whole number of months, and
the honest one. Adding a second constant per period would be four numbers to
keep in step instead of `MONTHLY_GOAL_HOURS` alone.

**The CURRENT period's goal is pro-rated to the part of it that has
happened.** A quarter nine days old measured against a full quarter's target
reads "10% — Behind" on every screen in early January, which is a verdict on
the calendar rather than on the learner. Past periods are measured whole,
because they had the whole thing. Floor of 1/30 of a period, so the first day
of a month is not a division by zero.

**A period is CURRENT only when today falls inside it.** The first version
used "is it the last bucket", which was wrong for the reason the next section
fixes: the axis often ends in the past, and a finished week was being scored
against two days of goal.

**The browser maps a LABEL to a colour and never re-derives a band.**
`GOAL_TONES` in `lib/brand.js` is a lookup keyed by the four labels the API
sends — green once the goal is in reach, ochre while it is plausible, red
when it is not. A copy of the thresholds in JavaScript would be free to drift
from the one the API scored the number with.

#### The axis now runs through to today

`axis()` in `learning-hours.service.ts` took `first activity → last activity`.
A learner whose last lesson was in July therefore saw a page headed "July"
through September, and a goal page whose most prominent figure is two months
stale is worse than one showing an honest zero. It now runs
`first activity → max(last activity, current period)`.

The START is unchanged, and the distinction matters: §10.12's rule against
padding an axis is about LEADING emptiness — months before somebody joined,
which read as a collapse that never happened. A trailing gap is the learner's
own recent silence, which is information and the whole point of a goal page.

Both pages read the same `learnerHoursTrend`, so My Progress gained the same
fix in the same change.

#### Two labels that could read as each other

`Jun 26` was "June 2026" on the monthly axis and "26 June" on the weekly one,
with nothing on either chart saying which. The month now carries an
apostrophe (`Jun '26`) and the week leads with the day (`26 Jun`).

### 10.26 External certifications

`0036_external_certifications.sql`. A learner says "I did this elsewhere";
their manager confirms they did; L&D decides whether it counts. Read the
migration header first — the summary:

**NOTHING EXISTS UNTIL THE FINAL APPROVAL.** A submission writes one row and
one file and touches nothing else: no course, no assignment, no completion,
no hours, no learning path. That is the requirement expressed as an
implementation rather than as a flag somewhere — a learner cannot move their
own numbers by filling in a form, and a claim in a queue is visible to its
two approvers and to nobody else's figures.

**An approval writes a COMPANION COURSE, which is §10.7's pattern reused.**
One course, one module, one lesson of `content_type = 'external'`, the
learner's assignment and their completion — all in ONE statement. My
Courses, learning hours, the completed count and the analytics mode split
then pick it up through definitions that already work.

The alternative — a standalone table that each of those learns about — was
rejected for a specific reason beyond the four new code paths: §10.4
promises the per-COURSE minutes sum to the per-LEARNER total, and hours
belonging to no course cannot. Making it a course keeps that true.

`courses.external_certification_id` is the marker, mirroring
`courses.session_id`, and it is excluded at **seven** SQL sites across three
repositories — the Course Library list and its archived count, the two bulk
predicates, the catalogue's course read, and the pending-surveys read. Plus
`CoursesService.assertNotExternalCertification`, so the course editor
refuses it the way it already refuses a session training.

**It never auto-issues a certificate.** `getCompletionSnapshot` now returns
`externalCertificationId` beside `sessionId`, and `autoIssue` returns null
for both. The learner already holds a certificate — the awarding body's —
and minting a second in this product's name would claim credit for training
it did not deliver. Without the guard, every approval would mint one,
because the companion lesson is complete the moment it is created.

**Hours are stored in MINUTES though the form asks for hours.** Every
duration in this database is `duration_minutes`, the companion lesson needs
minutes anyway, and a second unit on one table is how a number gets
multiplied by sixty twice. The DTO converts once, at the boundary.

**No manager means ONE approval, and the learner is told so on submit.**
`sent_to` comes back naming either the manager or L&D, because a learner
told "sent to your manager" who has no manager is watching a queue that will
never move. The manager is resolved at submission and STORED: a reporting
line that changes mid-flight must not move somebody else's decision to a new
desk.

**An admin cannot skip the manager.** `decideAsAdmin` refuses a
`pending_manager` row with a 422 naming who has it. A two-step approval an
admin can short-circuit is a one-step approval with extra words.

**A refusal requires a reason**, enforced in the service rather than the DTO
because the rule depends on `approve` and a DTO cannot see across its own
fields. Telling somebody their evidence was not accepted without saying why
leaves them nothing to do next.

#### The file

**Local disk, and the reasoning is the INVERSE of §10.10's.** A thumbnail is
public and needs a stable anonymous URL; a certificate must never have one.
What makes disk right here instead is that the R2 variables are optional
(§9.1) — an R2-only certificate would be a dead Submit button in any
deployment that has not configured them, including a developer's.

So the bytes live under `UPLOAD_STORAGE_PATH/external-certifications/`,
which is deliberately OUTSIDE the directory `useStaticAssets` publishes.
The only way to read one is `GET /api/external-certifications/:id/file`,
which has **no `@Roles()`**: the three people entitled are not three roles
but a relationship to the row — its owner, the manager it was sent to, and
an admin of that learner's org. That is decided in the service (§5.3), so
there is one definition rather than three copies. Verified: owner 200,
that manager 200, an admin 200, an unrelated learner 403, another tenant
404.

Multipart on the submit route rather than a presign: the file is a scanned
certificate, and a presign would let a learner upload bytes no row ever
claims — the debris §10.9 had to write a sweeper for. Three checks, and the
third is the one that matters: the BYTES are sniffed, because a multipart
Content-Type is written by the client. If the row then fails to insert, the
file is discarded.

#### Two things that cost time, worth not repeating

**A partial unique index needs its predicate repeated in `ON CONFLICT`.**
`courses_external_certification_unique` is partial (`WHERE
external_certification_id IS NOT NULL`, because every other course has NULL
there and they must not collide). `ON CONFLICT (external_certification_id)`
alone fails with *"no unique or exclusion constraint matching the ON CONFLICT
specification"*. `courses.session_id` gets away with a bare clause because
ITS index is not partial.

**A backtick inside a SQL comment inside a `sql` template literal ends the
literal.** A comment mentioning a column in backticks produced six TS1005
parse errors, `nest start --watch` then failed every rebuild, and the OLD
process kept serving — so a fix that was definitely on disk appeared to
change nothing. Symptom to recognise: the running pid predates the edit.
Use plain words in SQL comments inside these templates.

Routes:

```
GET    /api/learner/external-certifications            my claims
POST   /api/learner/external-certifications            file one (multipart)
GET    /api/learner/team/external-certifications       my reports' claims  (view_team_learning)
PATCH  /api/learner/team/external-certifications/:id   confirm / decline   (view_team_learning)
GET    /api/admin/external-certifications              the queue + counts  (manage_certificates)
PATCH  /api/admin/external-certifications/:id          approve / decline   (manage_certificates)
GET    /api/external-certifications/:id/file           the document, entitlement in the service
```

**`manage_certificates` rather than a new permission.** Approving one puts a
completed course and its hours on somebody's record, which is the same
weight as issuing a certificate. A new catalogue entry would need its own
grant migration and every one of those signs every user in every
organization out once (§10.17).

**Known consequence, accepted by the owner:** an approved certification
counts as a COMPLETED COURSE, so it moves completion rates in the admin
analytics and reports. A learner can therefore show a completion figure that
includes training this platform never delivered. Two people approved it,
which is the control; the number itself does not distinguish them.

### 10.25 Self-enrolment, and the Course Catalogue

`0035_self_enrolment.sql` adds ONE column — `courses.self_enrol` — and the
rest of the feature is code. Read the migration header first; the summary:

**Half of it already existed and had no trigger.** `sessions.enroll_mode`
(`assigned` | `self`) and `session_waitlist` both shipped with 0025, but no
admin control set the mode and no learner route acted on it. TASTE §10.3.1.17
had already written the consequence down: *"there is no learner self-enrolment
endpoint in this product, so a Register button would be a control that does
nothing."* That is §5.2.1's screen-that-lies seen from the other side — the
capability was real, guarded and unreachable. So a second `self_enrol` column
on `sessions` would have been a second vocabulary for a state that was already
stored.

**A course gets a FLAG, a session keeps its MODE, and the difference is
seats.** A session's two values are exclusive: either an admin books people
onto a finite sitting or learners book themselves. A course has no seats, so
self-enrolment there is strictly additive — an admin may still assign it to a
department while learners also find it in the catalogue, and both write the
same `user_course_assignments` row. Modelling that as a mode would force a
choice the product does not need to make.

**A self-enrolled row is the one whose `assigned_by = user_id`.** No new
column: a row a learner created for themselves is precisely one whose assigner
is the assignee. §10.12 dropped the reports builder's self-vs-assigned
enrolment split because "there is no self-enrolment in this product, so the
split would be 100%/0% by construction" — that premise is gone, and the split
is now expressible from a column that already exists.

**Nothing downstream learned a new concept, and that is the whole design.**
A self-enrolled course writes the ordinary assignment row, so My Courses,
progress, learning hours, the leaderboard and certificates pick it up through
definitions that already work. A self-enrolled session goes through
`SessionsService.addToRoster`, never a direct insert, because being on the
roster IS being assigned the companion training (§10.7) — the same rule
§10.16 states for `promoteFromWaitlist`, and a hand-written roster row would
enrol somebody in name only.

Measured rather than asserted: a learner self-booked onto a session, was
marked present and the session completed, and their all-time hours moved
**29.1 → 32.8** — exactly the 222 minutes the sitting was scheduled for. No
code in `LearningHoursService` was touched.

**At capacity a learner joins the WAITLIST rather than being refused.** The
queue is what a full self-enrol session is for and it already existed; a 409
would send somebody away with nothing to do. `is_full`, `seats_left` and
`waitlist_position` are all derived by the service and sent down, so the
browser cannot hold a second definition of "full" that disagrees with the
write.

**Leaving is a SESSION-only route, refused once attendance is marked.**
`removeFromRoster` withdraws the training and deletes the completion it
credited, so allowing a late exit would erase a record of training somebody
actually did — and let a learner marked absent quietly remove the evidence.
There is deliberately no course equivalent at all: leaving one would delete
lesson completions genuinely earned, with no undo and no admin in the loop.
An admin can still unassign, knowing what it costs.

**Announcements fire on the TRANSITION into being open, never on every save.**
Both forms post the whole row on every edit, so `CoursesService.update` and
`SessionsService.update` each compare before and after — without that, fixing
a typo in a description would re-announce the thing to the whole
organization. §10.18 records the identical trap on a session's trainer. It
fires for either half of "open": switching self-enrolment on, and publishing a
draft that already had it on.

The audience is **active learner-portal accounts who do not already hold it**,
resolved by `learnerRecipientsWithoutCourse` / `learnerRecipientsNotOnSession`.
`r.portal = 'learner'` rather than `users.role`, which correctly includes a
Manager and excludes trainers — verified: opening a course notified 20
learners and 1 manager, no admins, no trainers, and nothing cross-tenant. The
NOT EXISTS is the point: telling somebody a course is newly available when it
has sat in their My Courses for a month is how people learn to ignore the
bell.

**Two notification types, not one.** A course can be started now; a session is
a date somebody has to keep free. One shared sentence would be wrong for
whichever it was not written for — the same reason a session already
announces to its three audiences in three sentences (§10.18).

Announcements are fired from `create` and `update` only. A bulk publish or
restore that happens to open a course does NOT announce; the catalogue is
still correct, and the bell is a prompt rather than the record (§10.18's own
framing).

#### A pre-existing over-notification, fixed on the way past

`SessionsService.addToRoster` notified **the whole roster as it then stood**,
not the people it had just added, because `enroll_all + department` names no
ids in the request and reading the roster back was the only list available.
The comment there wrote it off as rare — true while an admin adds people in
one go, and false the moment learners could add themselves: twenty
self-enrolments onto one session would have sent the first person nineteen
notifications.

`addToRoster` and `enrollDepartment` now `RETURNING user_id` past their
`ON CONFLICT DO NOTHING`, so the insert itself reports who actually joined and
the notification goes to exactly them. The department path gets the same fix
for free.

Routes, all `@Roles('learner')` and no `@Permissions()` — joining something
the organization has deliberately opened to everybody is not a capability it
then withholds from individuals:

```
GET    /api/learner/catalogue                          open courses + sessions, with my state
POST   /api/learner/catalogue/courses/:id/enrol        add a course (200, idempotent)
POST   /api/learner/catalogue/sessions/:id/enrol       book a place, or join the queue (200)
DELETE /api/learner/catalogue/sessions/:id/enrol       give up a place, or leave the queue
```

**`CatalogueModule` composes; it does not duplicate.** The list is its own
query because neither Courses nor Sessions can answer half of it, but every
write delegates to the service that owns the rule — the module, never the
repository (§3.2). Nothing imports `CatalogueModule`, so the two it imports
cannot become a cycle.

**The list's scope split is §10.12's rule applied in three places.** A course
is CONTENT (`contentScope`, so a platform-owned course is genuinely joinable),
the enrolment counted against it is ACTIVITY (its own `orgScope`, or a shared
course would show this tenant another tenant's headcount), and a session is
org-owned so `orgScope` is the whole predicate. Verified: an Invensis learner
sees none of Edstellar's open items.

#### Found while testing, NOT fixed here

`LearnerService.completeLesson` enforces the JOURNEY gate
(`assertCourseUnlocked`) but **not** the within-module sequential lock that
`LearnerService.lesson` enforces. Reproduced on a locked lesson: `GET
/api/learner/lessons/1` returned 403 *"This lesson is locked. Complete the
previous lesson first"* while `POST /api/learner/lessons/1/complete` returned
200 and credited the hours. That is exactly the failure §10.11 describes for
the journey gate — *"Gating only the read was the first version, and it was
worth nothing"* — one level down, and it predates this work entirely. It is
recorded here rather than fixed because changing lesson-completion semantics
reaches hours, certificates and journeys, and deserves its own change.

### 10.24 Course feedback: templates the admin writes

`0034_course_feedback.sql` adds three tables and two columns on `courses`.
Read the migration header first; the summary:

**IT IS NEVER PART OF COMPLETION, and that is the requirement rather than an
implementation detail.** Nothing in `CertificatesService.evaluate()`, the
completion definition (§10.11), `LearningHoursService` or the leaderboard
reads these tables, and `SurveysService.submit` writes nothing but its own
row. A learner who never answers still finishes the course, still earns the
hours, still gets the certificate — and the card, the dialog header and the
course form each say so in words, because a form sitting under the
assessments is otherwise read as the last thing standing between somebody and
their certificate.

**This is NOT `session_feedback` (0032), and the difference is the subject.**
That asks three FIXED questions about a sitting and its trainer reads it with
no names; this asks whatever the admin wrote about a COURSE and the admin
reads it with names. One table for both would be one table whose columns are
meaningful for half its rows. The one thing they share — `user_id` stored so
one person cannot answer twice — is stored for the same reason and read by a
different audience:

| | who may see the author |
|---|---|
| `session_feedback` | the admin only; no trainer route selects `user_id` |
| `course_feedback` | the admin, and the form says so before the first answer |

**Which form a course shows is resolved in ONE method**,
`SurveysService.resolveTemplate`, read by the learner's form, the learner's
submit and the admin's course editor:

```
feedback_enabled = 0        -> none
feedback_template_id SET    -> that template, whatever the category says
feedback_template_id NULL   -> the CATEGORY's: Technical -> technical,
                               Compliance -> compliance, else standard
a session's companion course -> none (it is rated through the session, §10.7)
```

Two columns rather than one nullable id, because "off" and "which one" are
different questions. NULL is the default, so every existing course followed
its category the moment the migration ran — no backfill, no course form to
open. `GET /admin/surveys/options` returns `category_templates` already
resolved so the browser renders the answer instead of mirroring the rule;
a copy of it in JavaScript would be free to drift from the form a learner is
actually shown.

**The three seeded templates cannot be deleted, and everything else about
them can change.** The resolver looks them up BY KEY, so deleting `technical`
would leave every Technical course resolving to nothing with nothing on
screen to say why. Their names, descriptions and whole question sets are
editable, which is what the owner asked for; `is_active` is also refused on
them, for the same reason — turning feedback off is a per-COURSE control,
which is where an admin looks for it.

**`answers` is a jsonb document, with §10.14's cost restated because it
applies unchanged.** Five question types over a fully custom question set is
not a relational shape. So: **`answers` is not queryable as structured
data.** "Average rating across Technical courses" is not a SELECT over this
column, and anything that needs reporting on must first be promoted to a real
column — the way `service_requests.timeline` was.

**`validateAnswers` is a WHITELIST, not a type check.** It keeps only answers
to questions that are actually on the template, because the column is written
from a request body and without it a caller could store arbitrary keys of
arbitrary size in something nothing validates. The per-type checks (a rating
is 1–5, a choice is one of the offered ones) sit inside the same loop.

**An open text question is never required.** Enforced in
`normaliseQuestions`, not merely disabled in the editor: a mandatory essay is
how a form gets abandoned, and an abandoned form collects nothing at all.

**Questions are validated BEFORE the template row is written.** They were not
at first, and a mistyped choice list left an empty template behind on every
refused create — so the next attempt with the same name silently got a `-2`
key. Same ordering now in `update`, so a refused question set cannot leave
the name already renamed.

**`replaceQuestions` deletes and re-inserts in one transaction** — the editor
always resends the whole ordered list, so a diff would be a slower route to
the same rows. The cost is stated where it lands: answers already given are
keyed by the OLD question ids and keep them, so the admin's read pairs what
it can and lists the rest as *"a question that has since been changed"*.
Re-labelling an old answer with new wording would put words in somebody's
mouth.

**`course_feedback` is ACTIVITY, so `orgScope`, never `contentScope`** — even
though the COURSE may be platform-owned and shared. §10.12's rule applied
before rather than after a leak: the content predicate says whether this admin
may see the course and nothing at all about whose opinion is counted against
it. Verified: an Invensis admin sees none of Edstellar's answers and 404s on
its templates.

**`course_feedback_received` notifies the org's admins on the FIRST
submission only.** An upsert that re-rang the bell on every edit is one
admins learn to ignore (§10.18), so the repository returns `xmax = 0` as
`created` and the service branches on it. The learner IS named, unlike
`session_feedback_received` — the rule is anonymous to everyone except the
admin, and an admin is exactly who receives it.

**Submitting returns 200, not 201**, with `@HttpCode(200)`: the row is an
upsert and a learner correcting their own answer has created nothing.

**Timestamps are converted to ISO at the service boundary.** `toIso()` in
`surveys.service.ts` — a Postgres timestamp has a space and a `+00` that
`new Date()` rejects, which TASTE §10.3.1.15 records as a whole column of `—`
on a screen being sent real dates. Every date this module sends is real ISO,
so the browser needs no patching up.

**No new permission.** The admin controller carries `manage_courses`, which
is a truthful guard rather than a convenient one: which form a course shows
is literally a column on `courses`. A dedicated `manage_surveys` would need
its own grant migration, and every one of those bumps `perm_version` and
signs every user in every organization out once (§10.17). When an
organization needs somebody who can read feedback without editing courses,
that is the moment to add it and pay for the migration.

Routes:

```
GET    /api/admin/surveys/templates                the org's forms + three counts
GET    /api/admin/surveys/templates/:id            one, with its questions
POST   /api/admin/surveys/templates                create
PATCH  /api/admin/surveys/templates/:id            name, description, active, questions
DELETE /api/admin/surveys/templates/:id            refused for a seeded one
GET    /api/admin/surveys/responses                what learners said, paginated
GET    /api/admin/surveys/options                  filters + the category mapping
GET    /api/admin/surveys/courses/:courseId        what THIS course resolves to

GET    /api/learner/courses/:courseId/feedback     the form + my own answer
POST   /api/learner/courses/:courseId/feedback     submit or revise (200)
```

### 10.24.1 The learner's feedback inbox

`GET /api/learner/surveys` returns `{ pending, submitted }` — every course
this learner has FINISHED that asks for feedback, split on whether they have
answered.

**ONE query for both halves.** `pendingCoursesForLearner` became
`feedbackCoursesForLearner`: the `NOT EXISTS (course_feedback)` filter came
out of the SQL and `answered_at` went in, so the service splits one result
instead of a second near-identical query existing that could disagree with
the first about what "finished" means. `pendingForLearner` — which the
dashboard panel reads — is now a view over this, so the panel and the
Surveys page cannot report different numbers. Verified: submitting one form
moved the page 3 pending to 2 and the dashboard panel with it.

**`created_at`, not a submitted stamp.** `course_feedback` keeps one
timestamp because the answer is an upsert (§10.24); it is when they first
answered, and the column named `submitted_at` does not exist. Worth knowing
before reaching for one.

**Session feedback is NOT folded in.** It is a different table with
different questions and a different reader (§10.20), served by
`FeedbackService`. The page reads both endpoints and shows them side by side
rather than one service pretending to own both — the same reason §10.24
gives for not sharing a table.

**No organisation-survey feature exists**, and the learner page deliberately
does not render a section for one. See TASTE §10.3.1.25.

### 10.23 A platform course could never issue a certificate

`CertificatesRepository.getCompletionSnapshot` scoped the COURSE with a raw
`courses.organization_id = <this org>` in all seven of its correlated
subqueries. That is §10.12's rule read backwards: a course is CONTENT, and a
course Edstellar publishes to every tenant carries the PLATFORM org's id.

For a tenant's learner every subquery therefore resolved to zero rows —
`totalLessons` came back 0, `evaluate()` read that as `no_lessons`, and
`autoIssue` returned null. **A learner could finish a global course completely
and never be issued a certificate, with nothing anywhere saying why.** Found in
the local database: seven learners across two tenants had completed every
lesson of the one platform course and held no certificate between them. The two
certificates that did exist were written by `db:seed-history` directly, never
through `autoIssue` — which is exactly why the gap survived.

**The fix is the §10.12 pairing, applied per subquery rather than globally:**

| Subquery | Course predicate | Activity predicate |
|---|---|---|
| totalLessons, activeAssessments, sessionId, courseName | content (org + platform) | — |
| completedLessons | content | `user_lesson_completions.organization_id = org` |
| bestScore, passedAttempts | content | `user_assessment_attempts.organization_id = org` |

Widening the course WITHOUT adding the activity predicate would have been the
worse bug: a shared course completed in another tenant would have counted
toward this learner's certificate. Both halves are needed, and the activity
tables carry `organization_id` precisely so this is expressible — verified,
514 completion rows, zero whose org disagrees with their user's.

`contentScope()` could not be used: it emits raw SQL with an alias and this
repository builds its subqueries with Drizzle, so the equivalent is one
`inArray(courses.organizationId, [org, platform])` constant shared by all
seven call sites rather than seven chances to drift.

**The certificate row is written to the LEARNER's org, not the course's** —
`create()` already did this, and it is what makes a shared course issue an
Edstellar certificate to an Edstellar learner and an Invensis one to theirs.
Verified end to end through the real learner API: the same course issued
`EDS-19-6-...` into org 10 and `EDS-19-21-...` into org 11.

**The certificate names the ORGANIZATION, not the product.** `findDetailById`
joins `organizations` on `certificates.organization_id` — the LEARNER's org,
not the course's author — so one platform-authored course prints "Edstellar"
for an Edstellar learner and "Invensis Technologies" for theirs. The document
is issued by the employer who put the person through the training; Edstellar
authored the material, which is a different claim and not one a certificate
should make on a customer's behalf.

**The public verify route was deliberately left alone.** It returns the course
name, issue date and revocation state and NOT the learner's name; adding the
organization would tell anyone holding a code which company a person works
for. A certificate is shown to whoever the holder chooses; the verify endpoint
answers a narrower question and should keep answering only that.

**Backfill.** `autoIssue` fires once, at the moment a lesson is marked
complete — there is no scheduler and no retry — so fixing the query stops the
loss but cannot reach backwards. The four learners whose completions predated
the fix were issued through `POST /admin/certificates`
(`CertificatesService.issueManually`), never by writing rows: that path
re-checks completion itself and reports `hadCompleted`, so a backfill cannot
mint a certificate for somebody who did not finish. Verified afterwards: zero
learners still owed, and every certificate's organization matches its own
learner's.

**Production is not affected yet and this is preventative there** — it holds
zero platform-owned courses, so the gap would have bitten the first time
Edstellar published a global course to its tenants.

### 10.22 A reporting line, and Team Learning built on it

`0033_user_manager.sql` adds `users.manager_id` and changes what a team means.

**Team Learning was a DEPARTMENT and is now DIRECT REPORTS.** The old query
was `WHERE department = <the manager's department>`, which had two faults that
only show up with real org charts: two managers in one department each saw the
other's people, and a manager could not have a report outside their own
department at all. `manager_id` says who reports to whom, so the query says it
too. That supersedes `specs/rbac.md` decision 3 as the definition of a TEAM —
the RBAC row scope is a separate question and is untouched.

**No `role = 'learner'` filter on the team, deliberately.** A manager is also a
learner: the Manager role sits on the learner portal (decision 2), so they keep
My Courses, hours and certificates and simply gain a module. It follows that a
manager who reports to somebody appears in THAT person's team with their own
progress, and filtering the query by role would have hidden exactly those
people — a team smaller than the org chart says it is. Verified: a Manager
appears in her manager's team with her own 5 courses and 7.3 hours.

**Three refusals on a manager, and the third is why there is no CHECK
constraint.** `manager_id <> id` could be one; a cycle of two cannot — that
needs a walk up the chain, which is a query. Putting half the rule in the
database and half in the service means two places to read and one lying by
omission, so both live in `UsersService.assertManager`:

| Refused | Why |
|---|---|
| themselves | they would be their own team, listed looking at their own record |
| another organization's user | a cross-tenant leak through a column instead of a join. 404, not 403 |
| a cycle | neither person can be listed without listing the other, and any walk loops |

The walk is bounded by `MAX_CHAIN`, so a cycle that somehow already exists
cannot hang the request.

**`ON DELETE SET NULL`, never CASCADE.** A self-referencing CASCADE would take
a manager's whole team when the manager is deleted, and then their teams. That
is a delete nobody would predict from the button they pressed.

**Hours come from `LearningHoursService`, not a second sum** (§10.4), which is
what lets this page state a monthly figure that agrees with the learner's own
Learning Hours page. `MONTHLY_HOURS_GOAL` is a constant at 10: it appears in
one place and nothing else in the product has an opinion about it. Promoting it
to a per-tenant setting means a migration, a form, and a decision about the
months already measured against 10 — worth doing when somebody asks for a
different number.

**`avgScore` averages over the people who HAVE a score**, not over the team.
One untested person would otherwise drag it toward zero and read as poor
performance rather than missing data — and it is null, never 0, when nobody has
been assessed.

**A per-session average under three responses is withheld** is §10.20's rule;
the same instinct here is `needsAttention`, which is only rendered when
non-zero. A red "0 needs attention" is a false alarm.

Two routes beside the read:

```
POST /api/learner/team/:userId/nudge   prod one report
POST /api/learner/team/export          the same report as .xlsx
```

**Nudge is a notification, not an email** — this product has no mail transport,
and a button that silently sends nothing is worse than no button. The manager
IS named in it, unlike session feedback (§10.20): a nudge from nobody is just
nagging, and the learner should know who is asking. The path id is checked
against the caller's own reports, so it cannot be swapped for a colleague's.

**The export rebuilds through the same `team()` the screen reads**, so the file
can never describe a different team from the one on screen — the rule §10.12
records for the reports exports. Both routes carry `view_team_learning`, the
same permission as the read: a manager who can see somebody is behind can say
so, and a separate permission would be one nobody thinks to grant.

**A person with reports but no Manager role is FLAGGED, not auto-promoted.**
The directory returns `reports_count`, and Manage Users renders "manages 3 · no
Manager role" in `warning` beside their role. Auto-promoting would mean editing
one person silently changing another's permissions and signing them out, which
is a surprising blast radius for one form; doing nothing would leave data
recorded that nobody can read. The Change role action that fixes it is on the
same row (§10.21).

### 10.21 An admin can finally create a trainer

The session form's Trainer picker, `GET /admin/sessions/trainers` and the
name-derivation behind it all existed and all worked. The list was empty in
every organization anyway, because **nothing in the product could put a person
on a trainer role**:

| Step | Before |
|---|---|
| Create a trainer ROLE (`/admin/roles`) | worked, and offered the trainer portal |
| Put somebody IN it | `PATCH /admin/users/:id/role` existed, guarded, and **no client called it** |
| Create a user AS a trainer | `UsersService.create` hardcoded `roleByKey(scope, 'learner')` |

So the only route to a trainer account was `scripts/create-org-user.mjs` over
SSH, and its own docblock said so: *"A role selector in the Add User dialog is
the proper fix."* A guarded endpoint with no trigger is the same failure as a
permission with no guard (§5.2.1) seen from the other side — the screen does
not lie about what it can do, it simply never offers it.

**`CreateUserDto.role_id` is optional and means the learner role when
omitted**, which is exactly what the dialog did before and what the bulk
import still sends. It is a role ID, not a portal or a key: `users.role` is
written from `roles.portal`, so a caller cannot hold a learner role while
sitting on the trainer portal. An id from another tenant 404s.

**The seat check moved behind a portal test.** A seat is an active learner
(`0028`), so `assertSeatAvailable` now runs only when the chosen role is
learner-portal. Checking it for a trainer would refuse an account that
consumes nothing; skipping it for a learner would make the cap decoration.

#### Two holes closed in `RolesService.assign`

Both were reachable before any of this and neither had anything to do with
trainers:

**A role change could walk past the seat cap.** `assign` wrote the row with no
seat check at all, so an organization at its limit could convert a trainer or
an admin into a learner and exceed a number `create` refuses to let them
exceed. §10.17 calls a displayed-but-unenforced limit worse than none; this
was that limit enforced on one path and open on the other. Now, moving an
ACTIVE user onto a learner-portal role from a non-learner role asks
`assertSeatAvailable` first. Verified: at a cap of 21 the conversion returned
409 naming the number, and succeeded once the cap was raised.

**The last admin could be demoted.** Nothing stopped an admin moving the only
active admin-portal account onto another portal, leaving a tenant nobody can
administer — the exact state provisioning goes to a transaction to prevent
(§10.17) and the directory renders as a warning. `countActiveAdmins` excludes
the user being changed and the move is refused with a 409 when it would reach
zero. It counts `roles.portal = 'admin'`, not `users.role`, for the reason
`listOrganizationStats` already records.

**Assigning the role somebody already holds is a no-op that returns
`unchanged: true`** rather than bumping their `perm_version`. Without that,
re-saving the same role signed the person out for nothing.

`listDirectory` now also returns `role_id`, so the Change role dialog can
preselect what they already hold — without it the select opened blank and an
admin could not tell a no-op from a change.

#### A session now requires a trainer account

`SessionsService.create` refuses a session with no `trainer_user_id`, with a
422 naming the way out. **Enforced in the service, not the DTO**, because
`SessionDto` is shared with `update()` and sessions that predate trainer
accounts carry a typed name with no link — requiring it on edit would make
fixing a venue typo on one of those impossible without also reassigning its
trainer. Linking the account is the whole point: it is what puts the session
in a trainer's portal, which is where attendance is marked.

One consequence worth knowing: `npm run test:isolation` creates a session in
its fixture, so that fixture now resolves a trainer from
`/admin/sessions/trainers` at run time. It is discovered rather than
hardcoded, the same way the certificate fixture picks its courses — an
organization with no trainer fails setup with a sentence saying so.

### 10.20 Session feedback, and why the trainer never sees a name

`0032_session_feedback.sql` adds the table behind the trainer portal's
Feedback page and the learner's "Give feedback" control. Read the migration
header first; the summary:

**`user_id` is STORED and no trainer route SELECTS it.** Both halves are
load-bearing and neither works alone:

- stored, because `UNIQUE (session_id, user_id)` is what stops one learner
  rating a session five times, and because an admin investigating an abusive
  comment has to be able to attribute it. Anonymity to the trainer is a
  promise about who READS the column, not about whether it exists;
- never selected, because a learner who knows their trainer sees their name
  writes something politer than what they think. A named channel produces
  courtesy, and courtesy is not the point of asking.

That asymmetry survives only because it is enforced in ONE place.
`FeedbackRepository` groups its trainer methods under a heading that says so,
and they name their columns explicitly. §3.1 already forbids `SELECT *`; in
this table it is not merely over-fetching, it is breaking a promise the form
makes to the learner in words. **The notification carries the same rule** —
`session_feedback_received` is the only type in `common/notifications.ts`
written with no `actorName`, because a bell reading "Sneha rated your session"
would undo the whole feature.

**Eligibility reuses `FEEDBACK_ELIGIBLE_ATTENDANCE`, which is deliberately the
same three statuses that credit the training** (§10.7): `present`, `late`,
`partial`. One definition of "was in the room", not two that drift. It is
checked in the service rather than by a constraint, because attendance is
corrected afterwards (`syncCompletions` moves credit both ways) and a CHECK
would turn an admin fixing a mis-marked absence into a foreign-key error.

**Three ratings, not one average.** Content, trainer and delivery fail
separately and have different owners — thin material is the admin's to fix, an
unclear explanation is the trainer's, a broken joining link is neither. One
number would tell a trainer they scored 3.1 and nothing about which to change,
and two of the three are not theirs to change at all. `common/feedback.ts`
carries `ownedBy` for exactly that, and the trainer page prints it.

**An average over fewer than `MIN_RESPONSES_FOR_AVERAGE` (3) responses is
WITHHELD, not shown.** The service sends null and the count; the page says
"1 response — too few to average". Rendering a single 2/5 as "2.0 average"
invites a conclusion three more responses might reverse — the same refusal
§10.12 records as `sufficient: false` on the analytics trends. The headline
figures average over SESSIONS that clear the bar, not over every row, so one
heavily-answered session cannot drown out five quiet ones and the number
agrees with the cards under it.

**Submitting is an upsert and returns 200, not 201** — a learner correcting
their own answer has created nothing. It re-notifies only on the FIRST
submission: a trainer whose bell rang on every edit would learn to ignore it
(§10.18).

**`feedback_hero` was unearnable until this shipped.** `BadgesService.getStats`
hardcoded `feedbackCount: 0` with a comment saying no feedback table existed,
so a badge in the catalogue could not be unlocked by any amount of work. It
now counts real rows through `FeedbackService` — the module, never the
repository (§3.2).

#### A trainer assigned to a BATCH saw nothing

Found while building the calendar, and older than it. `session_batches`
carries its own `trainer_user_id` (0025), but `listForTrainer` and
`findTrainerSession` both filtered on `sessions.trainer_user_id` alone — so a
trainer given one sitting of a multi-batch session matched neither and opened
an empty portal while holding real work.

Both now go through `SessionsRepository.trainerOwns`, one private helper, so
the list and the ownership probe cannot disagree. That matters more than it
looks: had only the list been fixed, a session would appear on the calendar
and 404 when opened. `FeedbackRepository` has its own copy for the same
predicate over its own joins.

**The trainer's Training Calendar added NO endpoint.** It is a second view
over `GET /api/trainer/sessions`, which already returns date, times, venue and
attendance counts. A calendar endpoint beside it would be a second definition
of "my sessions" free to disagree with the first.

### 10.19 Branch locations and job levels became per-tenant data

`0031_org_workforce_options.sql` deletes `common/workforce.ts` and moves
`LOCATIONS` and `JOB_LEVELS` into `organization_locations` and
`organization_job_levels`, curated by the platform admin at onboarding.

**This reverses §10.12's stated decision, and the reason it is safe is WHO
curates.** That section argued there must be no table behind either list
because "a table would let an org invent a value, which is exactly what makes
`job_role` useless". The point stands — a reporting dimension is worth nothing
if its values do not repeat. What changed is that these tables are written by
`@PlatformAdmin()` routes ONLY; a tenant admin reads its own list and picks
from it, exactly as they picked from the constant. The values still repeat.
What Edstellar gains is the thing a nine-city Indian constant could not give:
a customer in Dubai.

**`users.location` and `users.job_level` stay `text`, with NO foreign key.**
This is the load-bearing decision:

- the reports builder filters and groups on those columns directly (§10.12); an
  FK means rewriting every one of those queries through a join for no gain,
  since the report needs the name the column already holds;
- an FK would make the migration non-additive — every existing value would have
  to resolve to a row first, and anything that did not would have to be
  destroyed. §6.2 calls that a human checkpoint, not a boot migration;
- renaming a branch must not rewrite history. Somebody recorded in "Bangalore"
  in 2024 still worked there after the office is renamed.

So the tables supply the OPTIONS a form may offer. They do not own the values
already on people.

**The backfill is the whole safety argument.** Without it the lists start
empty and every existing learner's location becomes unselectable — still in
the column, still grouping in reports, but no form could set it again. That is
the silent-omission failure §10.12 records for the two legacy spellings,
reintroduced deliberately. So `0031` inserts the DISTINCT values actually in
use per organization first, then the old constants. Verified after running:
**zero orphans** — no user holds a location or level absent from their org's
list.

**Removal is deactivation, never deletion** (`is_active = 0`). A branch no
longer offered still names where somebody worked, and with no FK to protect it
a delete would leave a value nothing could explain.

**Validation moved from the DTO to the service, and only where it is a WRITE.**
`@IsIn` compares against a value known at import time; the valid set is now a
per-tenant query. So:

| Path | Where it is checked |
|---|---|
| create / update a user, bulk import, own profile | `OrgOptionsService.assert*`, 422 naming that tenant's own options |
| reports FILTERS | nowhere — an unrecognised filter matches no rows and returns an empty report, which is a true answer |

The asserters return the LIST's spelling, so `"dubai"` is stored as `Dubai` —
one casing per value, which is the entire point of a closed list as a
dimension. That subsumes the old `LOCATION_ALIASES` Bengaluru/Bangalore table.

**The city database is server-side only.** `country-state-city` unpacks to
~17 MB. `GeoService` reads it and serves 250 countries and one country's
cities on demand; shipping it to the browser to fill one dropdown on one admin
screen would be the worst trade in the codebase. Cities are de-duplicated by
name — the source lists some once per district — and carry their state for
display only.

**`common/industries.ts` IS still a code catalogue**, and the distinction is
worth keeping straight: a branch location is a fact about one customer's
offices that only they know, while an industry is how EDSTELLAR segments its
own customer base. A list only Edstellar writes, read across every tenant to
compare them, belongs in code.

### 10.18 Notifications

`0030_notifications.sql` adds the bell that all four portals share. Read the
migration header first; the summary:

**A notification is NOT an activity row, and the difference is the recipient.**
`activity_log` is one row per event scoped to an ORGANIZATION, read as a feed,
with no addressee and no read state. A notification is addressed to ONE PERSON
and carries whether THEY have seen it. Assigning a course to fifteen learners
writes **one** activity row and **fifteen** notifications. Folding them
together would need a join table keyed by (row, user) — which is this table
with extra steps.

**`read_at`, not a boolean.** When somebody saw a thing is worth more than
that they saw it, and costs the same. NULL is unread; the badge is `COUNT(*)`
over NULLs, served by a PARTIAL index over unread rows only — that query runs
on every page load in every portal, so it is the one worth indexing well.

**`NotificationsService.notify()` never throws** (§8.4), the identical
contract to `ActivityService.record()` and for the identical reason: telling
somebody about a thing is secondary to the thing. Every caller `void`s it. The
cost is stated where it matters — the notifications that are missing are the
ones whose write failed, so nothing here may be the only way a person learns
something. The data is on their screens regardless; the bell is a prompt to
look.

`NotificationsModule` is **dependency-free**, like `ActivityModule` and
`JourneyGateModule` — every module that does something worth announcing
imports it, so it can import none of them. That is why
`platformRecipients()` resolves the platform org from
`organizations.is_platform` itself rather than taking an id: the alternative
was making eight callers inject `OrganizationsService` to fetch one number.

**One multi-row INSERT per fan-out**, never one per recipient (§7.1).
Assigning to a department is forty notifications on an admin's Save.

**`exceptUserId` is on almost every call, and it matters most where the volume
is.** An admin onboarding twenty people in a sitting must not get twenty
notifications about their own clicks — an admin whose bell lights up at their
own actions learns within a day to ignore it, and every other notification is
lost with it.

**Discrete events need no dedupe; recomputed state does.** Badges are safe
because `awardMany` is ON CONFLICT DO NOTHING and returns only rows it
actually inserted, so replaying the sync on every completion trigger cannot
re-notify. A leaderboard RANK has no such row, so `notifyOnce()` checks for
the same (user, type, subject) within N days — without it, "you are #2" would
fire on every lesson a learner finishes.

**A session announces to three audiences with three different sentences.** The
trainer is being given work, the admins are being told it landed, the roster is
being told who teaches them. One shared message would be wrong for at least
two of them. On create there is no roster yet, so learners hear it from
`addToRoster` instead — sending both would tell an enrolled learner twice.
`update()` compares the trainer before and after, because every session edit
posts the whole form and without that comparison fixing a typo in the venue
re-announces the trainer to everybody.

**`/api/notifications` has no `@Roles()` and no `@Permissions()`.** All four
audiences have a bell, so gating it to one would give three of them a control
that 403s; and your own notifications are not a capability an organization
grants. No route takes a user id — identity comes from the token and
`user_id` is in every predicate, so there is no parameter that could read or
clear somebody else's bell.

### 10.17 The super-admin portal: tenants, money, seats

Five capabilities behind `@PlatformAdmin()`, plus one tenant-facing controller.
Migrations `0026_tenant_profile.sql`, `0027_billing.sql`, `0028_seat_limits.sql`
— read each file's header first; the reasoning is there and is not repeated
here.

```
GET   /platform/service-requests            every tenant's requests, pending first
GET   /platform/service-requests/:id
PATCH /platform/service-requests/:id        move it along + the note the tenant reads

GET   /platform/organizations/tenants       directory: profile, contract, usage, money
PATCH /platform/organizations/:id           patch a tenant (omitted = leave alone)
GET   /platform/organizations/access        every privileged account, every tenant

GET/POST/PATCH/DELETE /platform/billing/invoices[/:id]
POST   /platform/billing/invoices/:id/payments
DELETE /platform/billing/invoices/:id/payments/:paymentId

GET   /platform/seats/requests               the queue
PATCH /platform/seats/requests/:id           approve/decline — approving WRITES the limit
PUT   /platform/seats/organizations/:id      set a limit directly

GET   /admin/seats            the tenant's own usage       (view_employees)
GET   /admin/seats/requests   usage + its own history      (view_employees)
POST  /admin/seats/requests   ask for more                 (manage_users)
```

**The platform service queue was built by ADDING a controller, never by
widening the tenant's.** §10.14 says a status write on
`/admin/services/requests` would let a tenant mark its own request "Proposal
sent"; that still holds. `PlatformServicesController` is a second controller
over the same service, and the repository grew `listAllForPlatform` /
`findByIdForPlatform` / `respond` beside — never instead of — the org-scoped
reads. Verified: the tenant reads the platform's note back, and a tenant admin
gets 403 on the platform route.

**Contract state is derived, invoice state is derived, seat pressure is
derived.** `common/tenant-account.ts` turns `contract_end` into
`none | active | expiring | expired` with `RENEWAL_WARNING_DAYS = 60`;
`common/billing.ts` turns an invoice's dates and payments into
`draft | issued | part_paid | paid | overdue | void`. Neither is stored, for the
reason §10.7 gives for a session's `display_status`: storing them needs
something to run at midnight, and if it ever failed the stored value would
contradict the dates printed beside it. The browser never recomputes either —
it renders what the API sends, so there is one definition of "expiring".

**Money is `numeric`, and pg hands it back as a STRING.** Every read converts
once at the service boundary (`BillingService.shape`, `listTenants`), never
with arithmetic on the raw value, and per-tenant totals are rounded to paise
once at the end — summing already-rounded floats is how a total drifts from
its own rows. `contract_value` stays null when there is no contract rather than
becoming 0: "no contract recorded" and "a contract worth nothing" are different
facts.

**`organizations.listTenants()` gets its money from `BillingService`, not a
second query.** §3.2 — the module, never its repository — so the directory and
the invoices page cannot disagree about what "collected" means.

**A seat is an ACTIVE LEARNER, and the limit is ENFORCED.** `UsersService`
calls `assertSeatAvailable()` in `create()` and in `setActive()` *only when
activating*, and it throws 409 with a message naming the number and the way
out. A limit that is displayed but not enforced is decoration and worse than
none — it tells an admin they are capped while letting them past it. Verified:
creating a learner at the cap is refused, deactivating frees a seat,
reactivating is gated again.

**`usage()` also returns a BREAKDOWN, and it is not part of the sum.**
`admins`, `trainers` and `learners` partition on `users.role` so the three are
the active headcount with nobody double-counted, and `learners` repeats the
same predicate as `used` rather than aliasing it — the panel prints both, and
if they ever diverge that is a bug worth seeing. Only `learners` counts
against the limit. The reference mock adds all three into its "used" figure;
that was considered and rejected, because it would mean an org choosing
between an extra trainer and an extra learner, and it would change
`assertSeatAvailable` to refuse admin and trainer creation at the cap. A
MANAGER rides in the learner portal and therefore does consume a seat — always
true of `used`, now stated rather than left to be discovered.

`onboarded_at` is `organizations.created_at`, for the panel's subtitle.

**Approving a seat request WRITES `organizations.seat_limit`.** An approval
that only moved a status would leave the tenant still capped while being told
they were not. `approved_seats` may differ from `requested_seats` — the
platform can grant 40 against a request for 50 and the tenant sees both — and
granting fewer than the tenant had in use when they asked is refused with a
422. Verified end to end through the real UI: approve-30-of-40 moved the
tenant's limit from 20 to 30 on the next read.

Four refusals on the billing side, each because the alternative corrupts a
ledger rather than merely annoying somebody:

| Refused | Why |
|---|---|
| a payment over the outstanding amount | almost always a typo or a payment booked against the wrong invoice |
| lowering an invoice below what is already paid | `outstanding` goes negative and the state reads "paid" for an amount nobody agreed |
| deleting an invoice with payments | the cascade takes the payment rows, erasing the record that somebody paid. Void it instead |
| a due date before the issue date | on create and on update, against the MERGED state |

#### My profile, and a tenant's own organization settings

Two pairs of routes behind the top-bar avatar, added by
`0029_profile_and_org_settings.sql`.

```
GET   /api/auth/profile          the caller's own record      (any role)
PATCH /api/auth/profile          edit it                      (any role)
GET   /api/admin/organization    the caller's OWN org         (admin)
PATCH /api/admin/organization    name / industry / region     (manage_organization)
```

**`UpdateProfileDto` is narrow, and the omissions are the design.** Read its
docblock before adding a field:

- **`email`** is the login identity. Changing it needs a uniqueness check and,
  more to the point, verification by somebody other than the person making it.
- **`department`** is an AUTHORISATION boundary, not a label. A Manager's row
  scope IS their department (`specs/rbac.md` decision 3), so a learner who
  could set their own would choose which manager sees them, and could move out
  of view entirely. This is the one that would have been easy to wave through.
- **`role`, `role_id`, `is_active`** are not in the DTO and not in the
  repository's signature. The narrowness is the safety, not a check upstream.

`job_level` and `location` ARE self-editable and are validated against
`common/workforce.ts` with the same `@IsIn` the admin's user form uses — one
rule whichever screen sent it.

**`AdminOrganizationController` takes no id.** Its org comes from
`@CurrentScope()`, minted from the verified JWT, so unlike the
`@PlatformAdmin()` controller beside it there is no path parameter for an org
admin to point somewhere else. The READ is open to the admin audience; the
WRITE carries `manage_organization`, so an org can define a restricted admin
role that manages users without being able to rename the company.

The GET returns the contract, plan, billing cycle and seat limit READ-ONLY.
The customer signed the contract and is entitled to see its terms without
asking; they are not entitled to rewrite them, and a tenant raising its own
seat cap would make the enforcement decorative. `UpdateOrgSettingsDto` carries
three fields and `updateOwnOrganization` passes them one by one rather than
spreading, so widening the DTO can never silently widen what a tenant may
write to its own row. Verified: a tenant PATCH naming `plan`, `slug`,
`contractEnd`, `seatLimit` and `isActive` changed none of them.

**`manage_organization` is the third catalogue addition to ship with its own
grant migration** (after 0016 and 0022) — read 0022's header for why the
backfill is safe. It bumps `perm_version`, so deploying it signs every
organization out once, deliberately.

**`phone` was added; `manager` was not** — and `0033` has since reversed that.
The reasoning at the time was that there was no reporting line in the product,
so a `manager_id` would render as "—" forever, the empty-column failure §10.12
records. The owner then asked for the reporting line itself, which removed the
premise rather than the argument. See §10.22; `UpdateProfileDto` still excludes
it, for the same reason it excludes `department`.

**A patch that names nothing is now a READ, not a 500.** Drizzle throws "No
values to set" on an empty `.set()`, which the filter correctly masks as
"Internal server error" (§8.3). That was reachable two ways: a form submitted
with nothing changed, and a tenant PATCH whose every key the global
`whitelist` pipe had stripped — so the fields were correctly ignored and the
response said the server had fallen over.
`OrganizationsRepository.update` returns the current row instead.

#### Provisioning a tenant, and support sessions

**`POST /platform/organizations` creates the organization, its three system
roles AND its first admin — in one transaction.** The admin is required, not a
second step. `users.role_id` is NOT NULL and must name a role in the same org,
so an org with no roles could never be populated (the bug §3.7 already
records); an org WITH roles but no admin is the next version of the same
problem — a tenant nobody can sign into, which the directory now renders as a
warning and the support-session button refuses. Doing it in the transaction is
what makes that a guarantee rather than an intention: there is no window where
the org exists and the account does not, and no compensating delete to get
wrong. Slug and email conflicts are checked BEFORE the write, so the caller
gets a sentence rather than a constraint violation.

`@IsDefined()` on the nested `admin` block is load-bearing:
`@ValidateNested()` alone skips an undefined value, so a body with no `admin`
key passed validation and the service then dereferenced `dto.admin.email` —
a TypeError, correctly masked as a bare 500 (§8.3). A missing required field
must never reach the service.

Profile, contract and seat limit are accepted at creation but written
AFTER the transaction, deliberately: they are optional, and a mistyped date
must not cost the tenant its admin account. The seat limit goes through
`SeatsService.setLimit`, never a second UPDATE here — one writer for that
column.

**There is no delete-tenant route, and `users.organization_id` has no
cascade.** Removing an organization means removing its people first. That is
the right default for a table holding somebody's learning history; if a delete
is ever needed it should be a reviewed script, not a button.

**`POST /api/auth/impersonate` opens a SUPPORT SESSION inside a tenant.**

It lives on the auth controller because what it does is mint a token and set a
cookie, and because `OrganizationsModule` importing `AuthModule` would be a
cycle (`AuthService` already depends on `OrganizationsService`).

The token carries the TENANT'S OWNER ADMIN identity — their `userId`,
`organizationId`, role and permissions — so every screen and query behaves
exactly as if that person had signed in. Nothing downstream learns about
impersonation, which is what keeps the feature at one method instead of a
predicate threaded through the codebase. The alternative (keeping the platform
admin's own `userId` with the tenant's org) was considered and rejected: a
great many queries assume the acting user belongs to the org being acted on,
and the payoff would have been a more truthful `actor_user_id` on a table
§10.12 already states is not an audit trail.

Five things make it accountable rather than a back door, and none is optional:

| | |
|---|---|
| Only `@PlatformAdmin()` reaches it | a tenant admin gets 403; verified |
| `impersonatorId` / `impersonatorName` ride on the token | the shell's banner, the platform refusal and the way back all read from them |
| It expires in **one hour** (`IMPERSONATION_TTL_SECONDS`) | and the cookie's Max-Age follows the token, or the browser keeps sending a credential the server has stopped accepting |
| `PlatformAdminGuard` refuses **every** platform route while it is set | inside a tenant you ARE that tenant. Explicit, ahead of the org check, because a bare "Forbidden" under a banner saying you are a platform admin reads as a bug |
| The TENANT is told | a `support_session_started` entry in THEIR activity feed. Support entering a customer's account is the customer's business |

The activity write is best-effort (§8.4) and therefore cannot be the record —
which is exactly why `AuthService` also logs both start and end at `warn`
unconditionally.

`POST /api/auth/exit-impersonation` is deliberately NOT `@PlatformAdmin()`:
that guard would refuse the one request whose purpose is getting back. The
claim says who to return to; the **row** says whether they may — the account is
re-read and re-checked to still be an active platform admin, so a support token
cannot outlive the permission that created it.

Refused, all verified: a second hop without exiting first, the platform
organization itself, an organization with no active admin account, a tenant
admin calling it at all, and exiting when not in a session.

**The tenant card names a REAL admin, read from `users` — never a typed-in
contact.** The first version printed `organizations.contact_name` /
`contact_email`, free-text columns somebody fills in, and the demo rows had
been populated from the reference mock — so the directory confidently named
two people who do not have accounts. Nothing checked them, so nothing could
have caught it.

`listOrganizationStats` now carries an `owner_admin` CTE: `DISTINCT ON
(organization_id)` over admin-portal accounts, Owner first, then oldest, so
every tenant resolves to one real account. Three things it gets right that a
hand-rolled version would not:

- **`r.portal = 'admin'`, not `users.role = 'admin'`.** A trainer's role sits
  on the `trainer` portal, so trainers drop out without being named. The two
  columns agree in the seed today, which is exactly why the difference is worth
  writing down rather than relying on.
- **Owner is the SAME derivation `listPrivilegedAccounts` uses** for its
  `level` column (`r.is_system AND r.key = 'admin'`). One definition, so
  Access Control and the directory cannot name different owners.
- **`admin_portal_count` is a window count over that same filter**, because the
  card prints "+N more admin" immediately beside the name. `admin_counts`
  counts `users.role` instead and feeds the platform totals; leaving the card
  to mix the two would let one number contradict the other standing next to it.

`contact_*` survives as what it always should have been — an OPTIONAL billing
or procurement contact, rendered separately and labelled, shown only when
somebody has actually recorded one. The mock values were cleared from the
database in the same change.

A tenant with no active admin-portal account renders a warning rather than an
empty row: an organization nobody can administer is a fact the super admin
needs, not a cosmetic gap.

**Access Control has exactly two levels, and they are DERIVED from the RBAC
role** — `CASE WHEN r.is_system AND r.key = 'admin' THEN 'owner' ELSE 'admin'`.
No new column, no third vocabulary beside `users.role` and the RBAC role. The
owner agreed to Owner/Admin only, and a level with nothing enforcing it would
be §5.2.1's screen that lies.

#### A sixth and seventh shape bug, same family

`ServicesRepository.getForPlatform` passed a raw-SQL row through `shape()`,
which expects Drizzle camelCase — the dialog rendered
`RAISED BY undefined · undefined`. It now returns the row directly, with a
comment saying raw SQL needs no shaping.

`SeatsRepository.create` and `.respond` were Drizzle `.returning()` calls
(camelCase) in a repository whose every read is raw SQL (snake_case), so the
row a tenant got back from `POST /admin/seats/requests` named every field
differently from the rows it got from `GET`. Both are raw SQL now, and the fix
was verified by diffing the key sets of the two responses. That is the §10.10
defect for the seventh time; the rule stands and is worth restating:

> When a repository mixes Drizzle `.select()` / `.returning()` with raw SQL,
> assume the two casings disagree until you have checked.

Two smaller ones fixed alongside: `roles` has no `name` column (it is `label`),
and `listPrivilegedAccounts` was written outside the class body (TS1434).

### 10.15 Archive, everywhere it belongs

`0023_journey_archive.sql` and `0024_session_archive.sql` give Learning Paths
and Live Sessions the `archived_at` column Course Library got in 0019. All
three follow one rule, stated once here rather than three times:

> Archive is a THIRD state, orthogonal to the row's own status. It is
> `archived_at`, never an extra value of `is_active` / `status`, because an
> archived row has to remember what it was so restoring returns it there
> rather than to a guess. The list never mixes the two sets — the flag SWAPS
> them — because an archived item appearing in a picker is the thing archiving
> exists to prevent.

Each gained a `POST .../bulk` route taking `{ ids, action }` and reporting
`{ affected, requested, action }`. Ids that fail the predicates are simply not
affected and the count says so, rather than the request erroring on the first
one — the shape `POST /admin/courses/bulk` already used.

The predicates differ, and each difference is a rule:

| Module | Action | Guard |
|---|---|---|
| Learning Paths | activate | `archived_at IS NULL` — publishing something meant to be out of circulation contradicts the archive |
| Learning Paths | all | `organization_id` (not `contentScope`) — a platform-owned path is not a tenant's to change |
| Live Sessions | cancel | `status <> 'completed'` — cancelling one would contradict attendance already credited against it |
| Live Sessions | delete | routed through `remove()` per id, NOT a set-based DELETE |

That last one matters. A session IS a course assignment (§10.7), so deleting
one cascades into its companion training course, its roster, its attendance and
every completion it credited — real learning history. `remove()` is the one
place that sequence is correct, so the bulk path calls it per id and counts
what succeeded. The UI's confirm dialog spells the cascade out and points at
archive as the reversible alternative.

**Sessions are org-OWNED, so `orgScope` is the whole predicate** — unlike
courses and paths there is no platform-owned session to exclude. Paths are
CONTENT (`contentScope` to read) whose enrolments are ACTIVITY (`orgScope` to
count), and `listForAdmin`'s new completion and score subqueries each carry
their own `orgScope` for the reason §10.12 records at length.

`idList()` now exists in three repositories — courses, journeys, sessions — all
for one Drizzle quirk: an array expands to a ROW constructor, so `id IN (...)`
becomes `IN ((1,2,3))` and Postgres rejects it. Worth lifting into
`database/` the next time a fourth is needed.

#### The Learning Paths builder was a mock

Worth recording, because it is the sharpest example of the failure §5.2.1
describes. `admin-journeys-content.jsx` was built entirely on a hardcoded
`SEED_JOURNEYS` array: **zero API calls**, while eleven working endpoints sat
behind it and `journeys` held zero rows in every environment. An admin could
fill in the form, watch a card appear, and lose it on the next refresh.

The page is now wired to those endpoints, so the primary fix was connecting it,
not restyling it. The route stays `/admin/journeys` while the label becomes
"Learning paths" — renaming the URL would break bookmarks and would disagree
with the API's own resource name.

### 10.16 Session batches, self-enrolment and the waitlist

`0025_session_batches.sql` completes Live Sessions against the reference. Read
the migration header before changing any of it — the whole design rests on one
decision.

**A BATCH IS NOT A COURSE.** §10.7 gives every session exactly one companion
training course, and that is what lets My Courses, hours, completion, the
leaderboard and certificates pick a session up through definitions that already
work. Modelling multi-batch as one course per batch would have meant
"completed" no longer meaning 100% of one course, two learners on the same
session holding different certificates, and moving somebody between batches
silently withdrawing one training and granting another.

So a batch is a **scheduling subdivision of one session's roster**. The session
still owns one training course. `session_roster.batch_id` says which sitting a
learner is in; `session_attendance` keeps its `(session, user)` shape, because a
learner attends exactly one batch and the pair is still unique — which is why
`syncCompletions` and every completion rule in §10.7 are untouched here.

**Batches are OPTIONAL, and that is what made it safe.** A session with no
batch rows is a single sitting using its own date, time and capacity — which is
every session that predates the table. The staged-lesson pattern from 0020
applied again: the new column is NULL everywhere, no backfill, and none of the
eleven session handlers needed rewriting.

`pending` is **derived, never stored**: a batch with no date yet is pending.
Storing it too would let the two disagree, the same reason `display_status` is
derived on the session itself.

**The waitlist is its own table, not a status on the roster.** A waitlisted
person is not enrolled: no `user_course_assignments` row, not in My Courses, not
in the roster count, not creditable by attendance. A flag on `session_roster`
would mean every one of those queries needing a new predicate, and the first to
forget would enrol somebody still queuing.

`promoteFromWaitlist` goes through `addToRoster`, never a direct insert —
adding someone to a roster is what creates their course assignment (§10.7), so
a hand-written roster row would enrol them in name only. The waitlist row is
deleted only AFTER the roster write succeeds: losing a place in the queue to a
failed enrolment is the worse outcome. Verified — promoting a learner moved the
waitlist 1→0, the roster 8→9, and created the training-course assignment.

Routes added:

```
POST   /api/admin/sessions/:id/batches           create a sitting
PUT    /api/admin/sessions/batches/:batchId      edit one
DELETE /api/admin/sessions/batches/:batchId      delete (roster falls back to no sitting)
PUT    /api/admin/sessions/:id/roster/batch      move a learner between sittings
GET    /api/admin/sessions/:id/waitlist          the queue, arrival order
POST   /api/admin/sessions/:id/waitlist/:userId/promote
DELETE /api/admin/sessions/:id/waitlist/:userId
```

The two roster-affecting ones carry `manage_session_roster`, not
`manage_sessions` — moving people and promoting them are roster writes, which
rbac.md §3.6.1 deliberately keeps separate from editing the session.

Deleting a batch is `ON DELETE SET NULL` on `session_roster.batch_id`: the
people in it stay on the session, unassigned to a sitting, and the admin
re-assigns them. Same choice 0020 made for lessons losing their module, and the
API says so in its response rather than leaving the admin to discover it.

`listBatchesForSessions` and `waitlistCounts` are **two queries for the whole
page**, not two per card (§7.1) — a list of 40 sessions costs 4 round trips.

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

#### Weekly joined the analytics axis

`GRANULARITIES` gains `weekly`, and it is **the one axis queried at its own
`date_trunc` unit**. Every coarser granularity folds monthly rows, which is
what stops a quarter disagreeing with the sum of its own months — but a week
straddles two months, so that trick does not work one level down.

`Period` therefore gained `keys`: the SOURCE ROW KEYS a bucket folds. Month
keys (`YYYY-MM`) for everything else, week-start dates (`YYYY-MM-DD`) for
weekly. `foldByPeriod` reads `keys` and takes its slice width from the axis
rather than assuming seven characters, so one function serves both shapes.

`buildWeekPeriods` is Monday-first, because `date_trunc('week')` is — a
Sunday-first axis would file a row in the bucket before its own. Labels lead
with the day (`28 Sep`) so a week can never be read as a month (`Sep 2026`).

Every series query already took a `TruncUnit`; only the whitelist and the
axis needed widening. Verified: Q1+Q2+Q3 2026 hours = the 2026 yearly figure
exactly, and the weekly buckets sum into their months.

#### The dashboard's hours tile takes a period

`engagement.hoursByPeriod` carries the same figure at four granularities.
**No extra query:** `MinutesRow` gained `this_week`, `this_quarter` and
`this_year` beside `this_month`, as three more `SUM(CASE …)` branches on a
scan the dashboard was already paying for — and the SCORM residual is
bucketed the same three ways in `scormMinutes`, or the quarter would be
lesson-only while the month included it.

The current-period starts come from `currentPeriodStarts()` in `periods.ts`,
built on `referenceNow()` — not `now()` in SQL — so pinning
`REPORTING_REFERENCE_DATE` moves these with every other figure instead of
leaving three tiles describing the real today.

Verified the two pages agree: dashboard `{6.9, 13, 33.5, 191.7}` matches the
last bucket of the analytics series at each granularity.

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
another origin, and `spectralms.edstellar.com -> lms-api.edstellar.com` is another
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

### 10.5.1 The points model is now readable, from the same file

`GET /learner/leaderboard` returns `pointRules` and `pointNotes`, and the
learner portal renders them as a "How Points Work" tab. The catalogue lives
in `modules/leaderboard/points.ts` **beside the constants the board pays out
with** — the values in it are `POINTS_PER_LESSON` and
`POINTS_PER_PASSED_ASSESSMENT`, never re-typed numbers, so changing a
constant moves the explanation and the payment together.

That is the whole reason it is served rather than mirrored in the browser. A
hardcoded table beside a live formula is §5.2.1's screen that lies, and this
is the worst place for it: a learner who reads a value they never receive
stops trusting the board.

**Three rules, because there are three.** Lessons, distinct assessment
passes, and a completed path's own `points_bonus`. The reference design
lists eleven — top score, perfect score, finished early, session attended,
four community actions — and this product awards none of them. They are
omitted rather than listed at zero.

`points: null` with a `pointsLabel` covers the path bonus, which varies per
path; naming a number there would be wrong for every path but one.

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
