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
  { "userId": 5, "role": "learner", "email": "...",
    "firstName": "Sneha", "lastName": "Kulkarni", "exp": 1788000000 }
  ```
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

The filter replaces any 5xx body with `{ "message": "Internal server error" }`
and logs the stack server-side. Do not put a raw error message in a response.

### 8.4 Best-effort side effects must not break the caller

Work that is secondary to the request must never fail it. `autoIssue()` catches
everything and returns `null` — a certificate failure cannot break marking a
lesson complete. Log the reason; do not propagate.

---

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
| `SCORM_STORAGE_DRIVER` | no (`local`) | `local` now, `s3` when credentials arrive |
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
| users / employees | 9 | `server/src/modules/users` |
| courses / modules / lessons / assignments | 16 | `server/src/modules/courses` |
| assessments / questions | 12 | `server/src/modules/assessments` |
| sessions / roster / attendance | 11 | `server/src/modules/sessions` |
| learner (dashboard, courses, lessons, progress, achievements, leaderboard, learning-hours, change-password) | 10 | `server/src/modules/learner` |
| scorm (upload, assign, tracking, static content) | 9 | `server/src/modules/scorm` |
| certificates | 5 | `server/src/modules/certificates` |
| analytics / reports / export | 6 | `server/src/modules/reports` |
| media (lesson video + captions in R2) | 7 | `server/src/modules/media` |

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
- SCORM storage is behind `SCORM_STORAGE_DRIVER`; the S3/R2 driver is not
  written yet. Implement it as a `StorageService` interface with `local` and
  `s3` implementations so no call site changes.
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
- [ ] Are the status codes right (§8.2), and does the envelope match (§8.1)?
- [ ] Does any response contain PII the caller should not see?
- [ ] Are secrets read only through `ConfigService` (§9)?
- [ ] Is the migration ledger updated (§10)?
