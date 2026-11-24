# BACKEND_STRUCTURE — Edstellar LMS Server

> **Scope:** everything under `server/`. The frontend has its own standards doc at
> `client/TASTE.md`; the two never cross-reference each other's internals.
>
> **Status:** NestJS 11 · TypeScript 5.9 · Drizzle ORM 0.38 · PostgreSQL.
> Migration from Next.js route handlers is COMPLETE — all 85 handlers live here.
> The API has since grown to 339 route handlers across 59 controllers
> (counted 2026-11-20; per-module counts at the end of §10's ledger).
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

Checked against the code on 2026-11-20. Files are named where they carry a
rule; the rest of each directory follows §2.1.

```
server/
├── src/
│   ├── main.ts                  Bootstrap: global prefix, CORS, pipes, filters;
│   │                            WORKER=1 forks into worker.ts instead (§10.30)
│   ├── app.module.ts            Root module — imports features, binds global guards
│   ├── worker.ts / worker.module.ts   The pg-boss worker process (no HTTP)
│   ├── retention-cli.ts         `npm run retention:sweep` (§10.48)
│   │
│   ├── config/
│   │   ├── configuration.ts     Typed view of process.env (the ONLY env reader)
│   │   └── env.validation.ts    Fail-fast validation at boot
│   │
│   ├── common/                  Cross-cutting, feature-agnostic
│   │   ├── crypto/              password.util.ts (scrypt, format-locked §6.4),
│   │   │                        secret-box.util.ts (MFA secrets), unknown-password.ts
│   │   ├── decorators/
│   │   │   └── index.ts         @Public, @Roles, @Permissions, @PlatformAdmin,
│   │   │                        @CurrentUser, @CurrentScope, @AllowBeforeMfa
│   │   ├── filters/
│   │   │   └── http-exception.filter.ts
│   │   ├── guards/              Global, in this order: auth, rate-limit,
│   │   │                        mfa-enrolment, roles, permissions,
│   │   │                        platform-admin, tenant-context
│   │   ├── interceptors/        presence.interceptor.ts (users.last_seen_at)
│   │   ├── http/                security-headers.ts (§10.47)
│   │   ├── rate-limit/          @RateLimit and the budget store (§10.47)
│   │   ├── types/
│   │   │   └── authenticated-request.ts
│   │   └── *.ts                 Catalogues-as-code: permissions, notifications,
│   │                            badges, lesson-content, course-taxonomy, consent,
│   │                            incidents, certificate-branding, and others
│   │
│   ├── database/
│   │   ├── database.module.ts   @Global — the only global feature module
│   │   ├── database.service.ts  Owns the Postgres connection pool + Drizzle handle
│   │   ├── migration.runner.ts  Applies additive .sql on boot (advisory-locked)
│   │   ├── org-scope.ts         OrgScope, orgScope(), contentScope()
│   │   ├── public-id.service.ts URL UUID -> integer id (§10.34)
│   │   ├── id-list.ts           Shared `id IN (...)` helper
│   │   ├── migrations/          0000_baseline_schema.sql to 0072_engagement.sql
│   │   └── schema/              Drizzle table definitions, one file per domain
│   │       └── index.ts         Barrel — `import { users } from '@/database/schema'`
│   │
│   └── modules/                 One directory per business capability (46)
│       ├── HTTP:   ai-insights, assessments, audit, auth, badges, billing,
│       │           catalogue, certificates, community, competencies, courses,
│       │           email, engagement, external-certifications, feedback, geo,
│       │           health, incidents, journeys, learner, media, messages,
│       │           my-data, notifications, organizations, org-options,
│       │           referrals, reports, roles, scorm, seats, services,
│       │           sessions, surveys, users
│       ├── no HTTP: activity, ai, alerts, consent, files, leaderboard,
│       │           learning-hours, reminders, retention (services, crons)
│       ├── auth/                e.g. auth + mfa controllers, auth/mfa/
│       │                        password-reset services, token.service.ts,
│       │                        cookie.util.ts, dto/
│       └── certificates/
│           ├── certificates.module.ts
│           ├── learner-certificates.controller.ts
│           ├── admin-certificates.controller.ts
│           ├── public-certificates.controller.ts
│           ├── certificates.service.ts
│           ├── certificates.repository.ts
│           └── dto/
│
├── scripts/                     Ops scripts: seed.mjs (npm run db:seed), test-isolation,
│                                backfills, wipe/reset, migrate-scorm-to-r2, cliq-notify
├── storage/                     Local runtime files: uploads/, outbox/ (file mailer).
│                                SCORM is no longer here: it lives in R2 (§10.9)
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
| 429 | Over a rate limit; carries `Retry-After` (§10.47) | `RateLimitGuard` |

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
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | no (`true`) | Set `false` only to accept a self-signed Postgres certificate |
| `JWT_SECRET` | yes | HMAC key, ≥32 chars (boot fails otherwise). Server only: the client holds no signing secret now that the migration is complete |
| `PORT` | no (3001) | HTTP port |
| `NODE_ENV` | no (`development`) | `production` sets the cookie `Secure` flag |
| `WORKER` | no | `1` makes `main.ts` boot the worker (`worker.ts`) instead of the HTTP API (§10.30) |
| `CLIENT_ORIGIN` | no | Exact frontend origin(s) for CORS — comma-separated, no wildcard. The FIRST is canonical and is what email links are built from |
| `COOKIE_DOMAIN` | no (`localhost`) | At `localhost` the cookie is set with no domain; set to the shared parent domain in production |
| `AUTH_COOKIE_NAME` | no (`lms_token`) | Name of the session cookie |
| `AUTH_TOKEN_DAYS` | no (7) | Token + cookie lifetime |
| `MFA_ENCRYPTION_KEY` | for the app method | AES-256-GCM key (32 bytes hex/base64, or a passphrase) for encrypting TOTP secrets at rest (0058). Absent = the authenticator-app method is unavailable (the emailed-code method still works when email is on, §10.51); losing it after enrolment locks out everyone on the app method except by recovery code |
| `MFA_ENFORCE` | no (`true`) | `false` lifts the mandatory admin two-step setup gate (§10.49), for local testing only. Does not turn off MFA for anyone already enrolled |
| `MFA_EXEMPT_EMAILS` | no (empty) | Comma-separated addresses that skip two-step sign-in entirely: no challenge, no mandatory setup (§10.60). A shared demo account only; every other admin keeps it. Read once at boot |
| `R2_ACCOUNT_ID` | for video, documents, SCORM | Cloudflare account id; used to derive the endpoint |
| `R2_ACCESS_KEY_ID` | for video, documents, SCORM | R2 API token key |
| `R2_SECRET_ACCESS_KEY` | for video, documents, SCORM | R2 API token secret |
| `R2_BUCKET` | for video, documents, SCORM | Bucket holding lesson videos, captions, documents and SCORM packages |
| `R2_ENDPOINT` | no | Account-level S3 endpoint, **without** the bucket path |
| `VIDEO_URL_TTL_SECONDS` | no (900) | Lifetime of a presigned playback URL |
| `UPLOAD_URL_TTL_SECONDS` | no (3600) | Lifetime of a presigned upload URL |
| `VIDEO_MAX_BYTES` | no (2 GiB) | Rejected at presign, re-checked against R2 on confirm |
| `CAPTION_MAX_BYTES` | no (2 MiB) | Caption uploads are proxied, so this is a real body cap |
| `DOCUMENT_MAX_BYTES` | no (100 MiB) | Cap for an uploaded document — a slide deck, not a feature film |
| `UPLOAD_STORAGE_PATH` | no (`./storage/uploads`) | Root for files this process stores itself: course thumbnails, avatars and org logos (public, §10.10, §10.52), plus the private stores (certificate scans, shared files) served only through checked routes |
| `REPORTING_REFERENCE_DATE` | no | Pins "today" for reports. Leave UNSET in production — set it only to demo the seeded period |
| `CLIQ_CHANNEL_URL` · `CLIQ_WEBHOOK_TOKEN` · `CLIQ_BOT_NAME` | no | Operational alerts to the team's Zoho Cliq channel (§10.50). No token = alerts are only logged. The token is a credential: server `.env` only |
| `RETENTION_ENABLED` | no (`false`) | Master switch for the data-retention sweep (§10.43). Off = the daily job is a no-op |
| `RETENTION_DRY_RUN` | no (`true`) | When enabled, `true` only COUNTS and logs; set `false` to actually anonymise. Review the dry-run count first |
| `RETENTION_DEACTIVATED_USER_DAYS` | no (365) | Days after deactivation before a user's PII is anonymised |
| `RETENTION_AUDIT_LOG_DAYS` · `_ACTIVITY_LOG_DAYS` · `_SCORM_LOG_DAYS` | no (365 each) | Time limits for everybody (§10.48) |
| `RETENTION_READ_NOTIFICATION_DAYS` · `_UNREAD_NOTIFICATION_DAYS` | no (180 · 365) | Read notifications 6 months, unread 12 |
| `RETENTION_FAILED_EMAIL_DAYS` · `_DATA_REQUEST_DAYS` · `_RESET_TOKEN_DAYS` | no (180 · 1095 · 30) | Failed emails, closed privacy requests, expired reset tokens |
| `RETENTION_REMOVED_COMMUNITY_DAYS` · `_REFERRAL_DAYS` · `_CERTIFICATE_FILE_DAYS` | no (30 · 365 · 365) | Removed posts purged, unconverted referrals, external-certificate scans after the decision |
| `AI_ENABLED` | no (`false`) | Master switch for AI Insights (§10.54). Off = the OpenRouter client makes no call and returns null |
| `OPENROUTER_API_KEY` | for AI | OpenRouter key. Absent = AI stays off regardless of `AI_ENABLED` (warn-and-degrade) |
| `AI_MODEL` | no (`deepseek/deepseek-v4-pro`) | OpenRouter model id. The default REASONS, so outputs cost extra tokens |
| `AI_MAX_OUTPUT_TOKENS` · `AI_TIMEOUT_MS` · `AI_BASE_URL` · `AI_APP_TITLE` | no (3000 · 45000 · `https://openrouter.ai/api/v1` · `Spectra LMS`) | Token budget (covers reasoning), call timeout, endpoint, and the product name sent for OpenRouter attribution |
| `ORG_NAME` | no (`Edstellar`) | Script only (`scripts/migrate-tenancy.mjs`), not read by the API: name of the first real organization |
| `ORG_SLUG` | no (`edstellar`) | Script only (`scripts/seed.mjs`), not read by the API: organization `db:seed` seeds into |
| `EMAIL_ENABLED` | no (`false`) | Master switch. False writes no outbox rows at all |
| `EMAIL_DRIVER` | no (`log`) | `log` · `file` · `ses` · `gmail`. **Production runs `gmail`** |
| `EMAIL_FROM` | for sending | The sender address. `spectralms@edstellar.com` in production. The display name is the `PRODUCT_NAME` constant and there is no reply-to; `EMAIL_FROM_NAME` and `EMAIL_REPLY_TO` were removed (`EMAIL_CONSTANTS` in `configuration.ts`) |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | for `gmail` | OAuth. The refresh token expires in 7 days while the consent screen is in "Testing" |
| `GMAIL_SERVICE_ACCOUNT_KEY` / `GMAIL_IMPERSONATE` | alternative | Domain-wide delegation instead of a refresh token (does not expire); `GMAIL_IMPERSONATE` is the mailbox the service account sends as |
| `GMAIL_DAILY_CEILING` | no (2000) | Gmail's own daily cap, used to warn on misconfiguration; not enforced (`EMAIL_MAX_PER_DAY` is) |
| `SES_REGION` / `SES_CONFIGURATION_SET` | for `ses` | Built, not in use |
| `EMAIL_RATE_PER_SECOND` | no (1) | Worker pacing. One send, then sleep |
| `EMAIL_MAX_PER_DAY` | no (200) | **2000 in production** — which is Gmail's own Workspace ceiling, so there is no headroom left |
| `EMAIL_ALLOWLIST` | no (empty) | Comma-separated. Non-empty = a dry run: every other row is written `suppressed/not_allowlisted` and counted. **Empty in production — real learners are emailed** |

`EMAIL_BATCH_SIZE` (25 rows per drain tick) and `EMAIL_MAX_RECIPIENTS_PER_NOTIFY`
(200; one notification above it is SKIPPED, not truncated) are no longer
environment variables: they are `EMAIL_CONSTANTS.batchSize` and
`.maxRecipientsPerNotify` in `config/configuration.ts`. `SCORM_STORAGE_DRIVER`
and `SCORM_STORAGE_PATH` were removed with the local SCORM driver: SCORM is
R2-only (`scorm.module.ts`), and only `scripts/migrate-scorm-to-r2.mjs` still
reads `SCORM_STORAGE_PATH`.

The R2 variables are **not** boot-required: without them the API starts, logs a
warning, and returns 503 from the routes that need object storage: video,
uploaded documents and, since SCORM became R2-only, every SCORM route. `S3_API_ENDPOINT` from the
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
| learning community (learner feed/compose/reply/like; admin moderation) | 12 | `server/src/modules/community` |
| referrals (tenant files/reads; platform queue + convert) | 6 | `server/src/modules/referrals` |
| direct messages (learner inbox, thread, send, unread) | 4 | `server/src/modules/messages` |
| my data (PDPA export, correction/deletion requests, admin queue) | 6 | `server/src/modules/my-data` |
| consent capture + admin MFA (TOTP enrol/verify, login second factor) | 6 | `server/src/modules/auth` |
| community kudos + hashtags (give, people search, kudos board, tag suggest/trending) | 6 | `server/src/modules/community` |
| community groups + admin discussions (learner groups/join/leave; admin groups CRUD + discussion create) | 8 | `server/src/modules/community` |
| shared files (community Resource posts + DM attachments; one disk store) | 4 | `server/src/modules/files`, `community`, `messages` |
| retention sweep (deactivated-user PII anonymisation; cron, no HTTP) | 0 | `server/src/modules/retention` |
| leaderboard privacy (learner opt-out, org name display + on/off switch; fields on existing routes) | 0 | `server/src/modules/leaderboard`, `learner`, `organizations`, `auth`, `community` |
| consent log + consent withdrawal (history read; withdrawal as a data-request type; choices on POST /auth/consent) | 1 | `server/src/modules/consent`, `my-data`, `auth`, `email` |
| security incident register (platform: list, options, get, create, update, note, notify clients) | 7 | `server/src/modules/incidents` |
| request rate limiting + security headers (global guard, per-route budgets; no new routes) | 0 | `server/src/common/guards/rate-limit.guard.ts`, `common/http` |
| retention: full anonymisation, time limits, client offboarding (platform schedule/cancel/read) | 3 | `server/src/modules/retention`, `organizations` |
| two-step sign-in mandatory for admins, optional for all; no admin-set passwords (fields and guards on existing routes) | 0 | `server/src/common/guards/mfa-enrolment.guard.ts`, `auth`, `users`, `roles` |
| competencies — skills catalogue, course→skill mapping, gained skills recorded on completion (AI Insights foundation, Wave 0) | 6 | `server/src/modules/competencies` |
| AI foundation — OpenRouter client (off by default) + ai_insights store (AI Insights, Wave 1; no HTTP routes) | 0 | `server/src/modules/ai` |
| AI Insights verticals — learner recommendations + admin org briefing + Learning Intelligence (risk radar, course effectiveness, skill intelligence, inactivity) | 5 | `server/src/modules/ai-insights` |
| engagement — active-time tracking + engagement-vs-learning trend (ping + learner/admin trend reads) | 3 | `server/src/modules/engagement` |
| operational alerts to Zoho Cliq + `GET /api/health` (public) | 1 | `server/src/modules/alerts`, `health` |
| two-step sign-in by authenticator app OR emailed code (resend at sign-in, email-me-a-code to turn off) | 2 | `server/src/modules/auth`, `email` |
| audit log reads, tenant + platform (§10.32; recorded by middleware, not a controller per route) | 4 | `server/src/modules/audit` |
| tenant email outbox read + resend (§10.32) | 2 | `server/src/modules/email` |
| own avatar upload / remove (any role) | 2 | `server/src/modules/media` |
| platform analytics overview | 1 | `server/src/modules/organizations` |
| AI Insights page reads: learner charts and lenses (read + refresh) | 3 | `server/src/modules/ai-insights` |

The rows above record what each change ADDED, so they do not sum to today's
routes (some routes were later moved, merged or removed). The current count
per module, from `@Get/@Post/@Put/@Patch/@Delete` in every `*.controller.ts`
on 2026-11-20, is the check to repeat:

| Module | Routes | Module | Routes | Module | Routes |
|---|---|---|---|---|---|
| ai-insights | 8 | external-certifications | 7 | org-options | 4 |
| assessments | 15 | feedback | 3 | referrals | 6 |
| audit | 4 | geo | 3 | reports | 17 |
| auth | 20 | health | 1 | roles | 12 |
| badges | 1 | incidents | 7 | scorm | 14 |
| billing | 7 | journeys | 12 | seats | 6 |
| catalogue | 4 | learner | 12 | services | 6 |
| certificates | 7 | media | 17 | sessions | 25 |
| community | 28 | messages | 5 | surveys | 13 |
| competencies | 6 | my-data | 7 | users | 11 |
| courses | 24 | notifications | 3 | | |
| email | 9 | organizations | 12 | | |
| engagement | 3 | | | **total** | **339** |

`activity`, `ai`, `alerts`, `consent`, `files`, `leaderboard`,
`learning-hours`, `reminders` and `retention` have no controller: their reads
are served through other modules (the learner and admin leaderboard and
learning-hours routes live on `learner` and `reports`).

### 10.33 No bulk-created learner slips through the welcome email

`0044_welcome_pending.sql`. The welcome-email feature (§10.31) had a gap that
is the exact one the outbox pattern (§10.30) exists to prevent, reappearing
because the bulk path cannot use it the way the pattern assumes.

**The gap.** `bulkCreate` commits learners one per row, then enqueues their
welcomes in a batch AFTER the loop (§7.1 — one `issueMany` and chunked
`enqueue`, not 1,000 round trips). That batched enqueue is best-effort (§8.4):
a restart in the window, or a failed chunk write, leaves a learner created
with no welcome row and nothing to retry it — and the admin's Resend only
recovers a FAILED row (§10.32), never a MISSING one. The outbox guarantees
delivery only once the row EXISTS; nothing guaranteed the row came to exist.
The reason it cannot just be fixed the §10.30 way — outbox row in the same
transaction as the business row — is that there is no single transaction: N
user inserts, then one enqueue.

**The fix is a durable flag, written WITH the learner.**
`users.welcome_pending_since` is set in the SAME INSERT that creates the
learner, when the welcome was requested — so if the learner row exists, the
intent is recorded, atomically, with no window. It is the one signal that
distinguishes the three cases a reconciler must tell apart, and heuristics
(a dangling token, a recent `created_at`) cannot:

| State | flag | welcome row | meaning |
|---|---|---|---|
| opted out | never set | none | leave alone |
| sent | cleared | exists | done |
| **lost enqueue** | **set** | **none** | **re-queue** |
| lost clear | set | exists | clear the flag, send nothing |

**The happy path keeps it transient.** `sendWelcomeMany` clears the flag for
everyone it queued, in the same request — so a flag still standing minutes
later is a genuine straggler, which is all the sweep ever acts on.

**The sweep reuses the ONE credential path.** `reconcileWelcomes` (in
`PasswordResetService`, beside `sendWelcomeMany`) reads flags older than a
grace window, asks the outbox which already have a welcome row (clear those,
send nothing — idempotent against a lost clear), and sends the rest through
`sendWelcomeMany` itself. There is no second place that mints a sign-in
token. Verified across all three live branches: a simulated lost-enqueue was
re-queued and only it; a lost-clear cleared the flag with no duplicate; a
second run was a clean no-op.

**It runs on the worker, every 10 minutes**, scheduled by pg-boss beside the
drain and the sweeps. A learner who cannot sign in is more urgent than the
hourly failure alert, hence 10 minutes; the grace window keeps it from
racing a request about to clear the flag itself.

**The cost, stated honestly: `WorkerModule` now imports `AuthModule`** — and
through it Organizations, Activity and OrgOptions — which is heavier than the
lean worker §10.30 describes. That is the price of REUSING `sendWelcomeMany`
rather than writing a second token-minting path in a worker-local service;
the codebase's standing rule is that one credential path beats two, and a
worker that constructs an unrouted `AuthController` is a smaller cost than a
duplicate way to create a sign-in link. `idList` was also lifted to
`src/database/id-list.ts` (§10.15 foretold the fourth copy); the local copy
in `email-outbox.repository.ts` is gone.

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

**There is deliberately NO webinar branch.** When this was written
`sessions.session_type` accepted `ILT` and `Virtual` only, so a webinar bucket
would have been zero on every row for every learner in every tenant — the
empty-column failure §10.12 records. The reference design shows four series;
three are built. The colour is reserved in `globals.css` and `lib/brand.js`.

Superseded (2026-11-20): the enum now accepts `Webinar` too (`sessions.schema.ts`,
`SessionDto`), treated as a virtual sitting. `learningTypeExpr` still has no
webinar branch, so a Webinar session's hours are filed under `session`. Adding
the branch is one line in that CASE.

**Learning paths currently total zero everywhere, and that is DATA, not a
gap.** `journeys` holds no rows in any environment yet, so the tab and the
column are honestly empty and the empty state says an admin builds these from
existing courses. That is the difference worth keeping straight: the webinar
column *is not built* (webinar hours count as sessions), the paths column *is
not yet* non-zero.

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
`SCORM_STORAGE_DRIVER` as it then was, so the whole feature is exercisable with no account
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

**A token knows what it was issued FOR** — `password_reset_tokens.purpose`,
`'welcome'` or `'reset'` (0045, default `'reset'`). Consuming a WELCOME link
used to send the "your password was changed — somebody else may have access"
alert to a person who had just chosen their first password: every new user,
alarmed on day one. A welcome link now skips that alert, the check route
returns `purpose`, and the page says "Your password is set" instead of
"changed… every session ended". A reset still sends the alert.

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

**The manager's confirmation has its OWN notification type,
`external_cert_confirmed`.** It was sent as `external_cert_approved`, whose
email closes with "It now counts towards your learning hours" — false at that
step, since nothing exists until the final approval. Three outcomes, three
types: confirmed (a step), approved (the record changes), rejected. The bell
reads icon and group from the catalogue, so the new type needed no client
change.

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
| `course_feedback` | the admin in full; other learners as a FIRST NAME + LAST INITIAL only (below) |

**The learner-facing reviews relaxation (2026-10-13).** The owner's original
rule was "anonymous to everyone except the admin", and it still holds for the
one thing it was protecting — candid feedback the trainer must not trace. What
changed is that a learner on a course's detail page now sees the OTHER
learners' ratings and comments as edX-style social proof. The author is shown
as a **first name and a last initial** ("Vamsi K."), never the full surname,
email or `user_id`. That limited identity is the whole of the relaxation:
`SurveysRepository.courseReviewRows` takes the initial IN SQL so the surname
never leaves the database, `GET /api/learner/courses/:courseId/reviews` reads
no id, and `SurveysService.courseReviews` returns none. The admin's full-name
read (`listResponses`, the only one that selects `user_id`) is unchanged.

A review is the OVERALL rating (the template's first `rating` question) plus
the first non-empty `text` answer as the comment. A response with no numeric
rating is not a review and is left out of the average, the 5★→1★ distribution
and the cards — the star is the thing being counted. Entitlement matches the
feedback form beside it: the learner must be assigned the course. Scoping is
`orgScope` on `course_feedback` (§10.12) — a shared platform course must never
show one tenant another tenant's reviews.

**Fixed in the same change: the feedback card had gone silently blank.**
`LearnerSurveysController`'s `:courseId` was a `ParseIntPipe`, but the course
page sends a public UUID (§10.34), so `GET .../feedback` 400'd and the card —
whose rule is to render nothing on a failed fetch — showed nothing, which also
meant no new feedback could be collected from the page. Both it and the new
reviews controller now resolve the id through `PublicIdService`.

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

### 10.23.1 Three kinds of certificate, three designs

A certificate is one of three things, and `CertificatesService.certificateKind`
decides which ONCE, from the row:

| Kind | Decided by | Design | Details |
|---|---|---|---|
| `course` | neither of the below | blue · Certificate of Completion | category, issue date, duration |
| `path` | `certificates.journey_id` set | purple · Certificate of Achievement | the path's tag, its courses in order, count, total duration, completion date |
| `session` | the course is a session's companion (`courses.session_id`) | teal · Certificate of Participation | delivery mode, trainer, date, duration, venue |

The designs follow the owner's reference PDFs (`Edstellar-Course-`,
`-LearningPath-`, `-Session-Certificate.pdf`). `kind` rides on both the list
and the detail, so the list chip and the document cannot disagree; the
detail adds a `path` or a `session` block, null for the other kinds, read in
the same single query (§7.1).

**A virtual session's venue prints as "Online", never its meeting link.**
`sessions.venue_url` holds a room for ILT and a URL for Virtual, and a call
link on a document somebody keeps is a stale credential that reads as an
address.

**The signature is a person the ORGANISATION names** —
`organizations.certificate_signatory_name` / `_title` (`0039`), edited in the
admin's Certificate branding panel under `manage_organization`. The reference
PDFs are signed by Edstellar's CEO; printing him on another tenant's
certificate would put Edstellar's name on a document their employer issued
(§10.23), so each tenant enters its own. NULL is the default and signs with
the organisation's name and "Issuing organisation", which is what every
certificate said before. It is read when a certificate is OPENED, unlike the
prefix, which is frozen into the code at issue: a code is what verify looks
up, a signature is presentation.

**Kept although the reference omits it: the certificate ID**, small at the
foot. It is the only thing `GET /api/certificates/verify/:code` takes. The
final score stays off all three, on the owner's earlier instruction.

A session certificate is still issued only by hand (`issueManually`),
because auto-issue refuses session trainings (§10.7).

The printable document (`client/components/learner/certificate-print-view.jsx`)
was rebuilt to the owner's reference `openCert` HTML on 2026-10-16 — its gold
seal above the signature is the one element it had lacked — while keeping the
TENANT's branding and signatory rather than the reference's hardcoded Edstellar
wordmark and CEO, for exactly the reason this section gives. The three `kind`
values and everything the API decides are unchanged; this was a client-only
visual change, no migration, no new field.

#### Backfilling the certificates completion already earned

`scripts/backfill-certificates.mjs` issues the certificates that completion
should already have produced but did not — `autoIssue` fires once, at
lesson-complete, with no scheduler or retry (§10.23), so a course finished
before the platform-course scope fix, a path completed before §10.11 wired
`issueForJourney`, or history written straight into the tables all leave a
completion with no certificate and nothing to mint one. It re-uses the ONE
completion definition (`evaluate` over `getCompletionSnapshot`, inlined as SQL):
every active lesson done, the assessment passed if there is one. It will not
touch a session training (§10.7), an approved external certification (§10.26),
or any (user, course|journey) that already holds a certificate — revoked or
not — and the learner's org owns the row, so a shared course finished in another
tenant does not leak one here. It does NOT notify or email: these are historical
completions. Dry-run by default, `--commit` to apply, `--org=` to scope — the
same convention as the other data scripts (§10.6). A path cert needs
`course_id` nullable (`migrate-journey-certificates.mjs`); the script says so
rather than failing on the INSERT.

#### A new migration is not copied into dist by watch mode

`nest-cli.json` has `watchAssets: true`, and a `.sql` file CREATED while
`nest start --watch` is running was still never copied to
`dist/database/migrations/`, so the boot-time runner never saw it — while the
code reading its columns had already reloaded and answered 500. Touching the
file did not help, and nor did touching a `.ts` file (the compiler reacts to
content, not mtime). What worked: copy the file into `dist/` and make a real
edit to any `.ts` file. Then confirm the log says `Applied migration 00NN`,
never just that the server restarted. A fresh `npm run build` or process start
copies it normally — this only bites a migration added to a running dev
server.

### 10.23.2 Short certificate IDs, a QR, and a public scan-to-verify page

The owner's request (2026-10-23): a short, human certificate ID; a QR on the
document; and a mobile verification page the QR opens.

**The code is now `<prefix><hex>`, ten characters.** `EDSA2F9BD3` by default,
`INVA2F9BD3` when a tenant sets its own prefix (the `organizations.certificate_prefix`
that already existed, §10.23.1). `buildCertificateCode` in
`common/certificate-branding.ts` fills `10 - prefix.length` hex characters, so a
3-letter prefix lands on 7 random, a 4-letter on 6 — both ten in all, with a
`MIN_FILL` floor so a longer prefix stays unique rather than shrinking to nothing.

**Uniqueness moved from entropy to RETRY, and that is the load-bearing change.**
The old 16-char code leaned on 12 hex because `certificate_code` is UNIQUE NOT
NULL and the hash was the only thing keeping codes apart (§10.23.1's own note
argued for the length). Ten characters cannot: 7 hex clashes around 16k rows by
the birthday bound, and a clash is not cosmetic — the insert fails and a learner
gets no certificate. So `CertificatesService.generateUniqueCode` loops
build → `repository.codeExists` → retry (bounded at 20), and the UNIQUE column
is the backstop. The old `generateCode` / `generateJourneyCode` /
`codeHash`-based construction is gone; one format serves course, path and
session because the KIND is derived from the row (`journey_id`,
`courses.session_id`), never parsed from the code. Old long codes still verify
unchanged — nothing parses a code.

**Two ops scripts still mint the OLD long format** (`backfill-certificates.mjs`,
`seed-history.mjs`): they carry their own inline copy because a `.mjs` cannot
import the TS helper, and both produce valid, unique codes. Not updated here to
avoid a collision risk in a script without the app's retry loop; a backfilled
certificate therefore carries a long code while app-issued ones are short. Both
verify identically. Worth aligning when either script is next touched.

**The QR is generated server-side and embedded as a data URL.** `getForLearner`
now returns `verifyUrl` (`<clientOrigin>/verify/<code>`, the canonical origin,
same source as email links) and `qrDataUrl` (a PNG via `qrcode`, already a
dependency from MFA §10.39). A data URL because the certificate is printed and
saved — it cannot fetch. Generation is best-effort: a QR failure returns null
and the document still renders. The client document (`certificate-print-view.jsx`)
draws the QR bottom-left with a "Scan to verify" caption, and a small line:
*"This certificate is digitally generated and does not require a signature. Scan
the QR code to verify its authenticity."*

**The verify page shows the full credential — reversing §10.23's no-PII rule,
on the owner's explicit call.** `GET /api/certificates/verify/:code` (still
`@Public`, still unknown-code-returns-a-shape so it is not a 404 oracle) now
also returns the holder's name, issuing organisation, kind, title, category,
duration and (for a session) format/date/trainer. The justification: the QR is
printed ON a document the holder is already presenting, so the page shows what
the document shows. It still returns no email, employee id or department.

**The consequence to track: enumeration is now real.** Short codes plus a named
holder make `GET /verify/:code` worth rate-limiting — it moves from the §10.3
"nice to have" follow-up to a required one. Codes are random hex (not
sequential), so bulk guessing is hard but no longer pointless. The public page
lives at `client/app/(legal)/verify/[code]` (plain shell, no auth; `/verify`
added to the middleware `OPEN_PATHS`), mobile-first, with a valid / revoked /
not-found banner.

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

Superseded (2026-11-20): email has since shipped (§10.30). `manager_nudge` is
an `announcement` type, so it also emails when the organization has
`email_announcements` on; it is still a bell notification first.

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

#### The trainer role is created on demand, from the Add User dialog (2026-10-15)

The Role selector could only offer roles the org already HAD, and the trainer
role is deliberately not in `SYSTEM_ROLES` — not every org runs its own
training, so seeding it into all of them puts an empty role in front of every
admin (`TRAINER_ROLE` in `common/permissions.ts`). So an org that had never
created one had no Trainer option, and the only ways to make one were
`scripts/create-org-role.mjs --trainer` over SSH or the roles screen — which is
§5.2.1's gap seen from onboarding: the trainer PORTAL, the welcome email and the
seat-free create all worked, and nothing could put the first person on the role.

`POST /api/admin/roles/trainer` (`@Permissions('manage_roles')`, 200) closes it.
`RolesService.ensureTrainerRole` creates the org's trainer role once, from the
`TRAINER_ROLE` seed (`is_system = true`, portal `trainer`, its three session
permissions), and is idempotent — a second call is a no-op returning the current
list, so the dialog can call it freely. The Add User dropdown offers "Trainer
(set up now)" only when the org has no trainer role; picking it creates the role,
reselects it, and the ordinary create path (above) does the rest — portal
`trainer`, no seat consumed, a welcome email with a set-password link, and the
trainer portal on next sign-in.

**It does NOT bump `perm_version`.** A brand-new role nobody holds changes no
existing user's effective permissions, so the org-wide sign-out a bump causes
(§10.17) would be gratuitous — and it would log the admin out mid-onboarding.
That is the one way this differs from `create` (which bumps) and from the grant
migrations `0022`/`0052` (which bump because they add a permission to roles
people already hold). `repository.create` gained an optional `isSystem` flag
(default `false`, so every existing caller is unchanged) to seed it as a system
role. Verified end to end against org 7, which had no trainer role: ensure
created it with the right shape, was idempotent, a created trainer landed on
`users.role = 'trainer'` with a welcome row enqueued, and no learner seat was
consumed.

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

### 10.18.1 Two catalogue types that had no trigger

`journey_assigned` and `session_cancelled` sat in `common/notifications.ts`
from 0030 with ZERO call sites — so a learner put on a learning path heard
nothing, and a cancelled session told nobody: people found out by turning up.
§5.2.1's screen-that-lies, seen from the inbox.

**`journey_assigned` goes only to the NEWLY enrolled.**
`JourneysRepository.enrollLearners` now returns `RETURNING user_id` past its
`ON CONFLICT DO NOTHING` — §10.25's fix for `addToRoster`, applied again — so
re-assigning a department tells only the people it actually added. Sent after
BOTH writes, so nobody is told about a path whose courses are not yet in My
Courses.

**`session_cancelled` fires on BOTH routes to cancelled** — the edit form and
the bulk Cancel action. §10.25 lets a bulk publish stay silent; a cancel may
not, because it is the one change that sends somebody to an empty room. It
fires on the TRANSITION only: `setCancelled` now excludes sessions already
cancelled and returns the ids that moved, and the edit path compares before
and after, so re-saving a cancelled session re-announces nothing. Two
sentences — the roster loses a booking, the trainer loses work.

Verified on a separate API copy against the shared database: one email per
person per route, none on a repeat, and the outbox's 5-minute dedupe correctly
swallowed a second cancel of the same session inside one window.

**Known and NOT fixed here:** the bulk Cancel does not deactivate the
session's companion training the way the edit form does (`trainingValues`
sets `is_active = 0`), so a bulk-cancelled session's card stays in My
Sessions. And un-cancelling a self-enrol session re-announces it to the whole
organization, by §10.25's open-transition rule — arguably right, but worth
knowing before reopening one.

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
seat cap would make the enforcement decorative. `updateOwnOrganization` passes
the DTO's fields one by one rather than spreading, so widening the DTO can never
silently widen what a tenant may write to its own row. Verified: a tenant PATCH
naming `plan`, `contractEnd`, `seatLimit` and `isActive` changed none of them.

**The `slug` (account identifier) is now BOTH entered at creation and editable
by the tenant admin** (owner's request, reversing two earlier decisions).
Provisioning no longer derives it from the name — `CreateOrganizationDto.slug`
is REQUIRED and the superadmin enters it (the client suggests one from the name,
editable; `deriveSlug` is gone). `UpdateOrgSettingsDto` now carries `slug`, and
`updateOwnOrganization` checks `slugExists(slug, exceptId)` first — excluding the
org's own row, so re-saving an unchanged value is not a false 409. It is still
unique platform-wide and URL-safe (the DTO's pattern rejects a bad format with
400 before the uniqueness check). Safe to change at runtime because the slug is
not used in any URL or at login (identity is per-email, §10.34 uses `public_id`
for URLs); ops tooling (`seed.mjs` ORG_SLUG, the isolation fixture) keys on it,
which is the one thing to know before renaming one.

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

**The first admin is WELCOMED, and the password is optional** (2026-10-07).
`NewTenantAdminDto.password` may be omitted: the account then gets an
unguessable password nobody holds, and the admin chooses their own from the
welcome email's set-password link — `PasswordResetService.sendWelcome(..,
'admin')`, the same path a learner's takes. A typed password still works at
once, and the email still goes. `PasswordResetService` moved into its own
`PasswordResetModule` (imports only `EmailModule`) because AuthModule imports
OrganizationsModule, so the reverse import was a cycle; AuthModule re-exports
it, so its existing importers are unchanged.

**Provisioning seeds the three built-in feedback forms.** 0034 seeds them for
every organization, but only at BOOT, so a tenant provisioned afterwards had
none until the next restart — every course resolved to no form and the admin's
Survey / Feedback page was empty. `SurveysService.seedSystemTemplates(orgId)`
runs the same two statements for the one org; keep it in step with 0034.

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
`client/lib/lesson-content.js`. Superseded (2026-11-20): the form now offers
FIVE (`video`, `pdf`, `image`, `link`, `scorm`); Word and PowerPoint were
removed as primary content (readable on old rows via `DOCUMENT_LIKE_TYPES`,
still valid as resources), and `session` is generated by its session, never
authored. Each entry carries its own `durationRequired`
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

> Superseded in part (2026-11-20): the `local` driver and the
> `SCORM_STORAGE_DRIVER` / `SCORM_STORAGE_PATH` switch were later removed.
> SCORM is R2-only (`S3ScormStorageDriver` is the one provider in
> `scorm.module.ts`), packages were moved with `scripts/migrate-scorm-to-r2.mjs`,
> and R2 is a hard dependency for SCORM (503 without it). The two-driver
> description below is the history; the same-origin serving rule still holds.

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

**Points are not written anywhere.** `LeaderboardRepository.pointEvents()` pays
`journeys.points_bonus` for every completed enrollment, so stamping
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
in `modules/media/dto/media.dto.ts`, which also accepts raster images). Upload
and link are equivalent options, and every resource type offers both.

Superseded (2026-11-20): as PRIMARY lesson content the form now offers only
`pdf` and `image` of the document-like kinds (plus `video`, `link`, `scorm`);
Word, PowerPoint and spreadsheets remain valid only as resources, and existing
rows holding them still render (`common/lesson-content.ts`).

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

**`scripts/wipe-to-superadmin.mjs` is the clean start for production, and
`db:reset-to-admin` must NOT be used for it.** The older script truncates
`roles`, and `users.role_id` references `roles`, so its `TRUNCATE ... CASCADE`
empties `users` too — every account, the superadmin included. It also keeps
every tenant's admins. The new script keeps the platform organization, its
roles and its admin accounts; removes every other organization and user; and
empties every other table. It refuses if any kept table has a foreign key
into a truncated one (checked from the live catalogue, so a schema change
cannot quietly widen it), runs in one transaction with a post-check before
COMMIT, and is dry-run by default. Run on 2026-10-07, locally and in
production, after a `pg_dump` (production's is in `/home/ubuntu/db-backups/`).
It does not touch uploaded files or the pg-boss schema.

`npm run db:seed-history` is the third data script and the only destructive one
that targets a SINGLE organization — see §10.12. Dry-run by default like the
other two.

Neither script touches `server/storage/uploads/` or the R2 bucket (which now
also holds every SCORM package) — extracted packages, uploaded videos and course thumbnails
outlive a database wipe and must be cleared separately.

### 10.5 Leaderboard

`modules/leaderboard` owns the single ranking, read by both portals. Points
are a SUM over `LeaderboardRepository.pointEvents()`, over active learners
only — see §10.5.1 for what an event is.

`is_active = 1` is filtered (deactivated learners kept competing, while the
dashboard's own user count already excluded them).

**The ranking is a hybrid, set by the owner (2026-10-14): the top three stay by
points, and everyone from rank 4 down is ordered by course completion %.**
`LeaderboardService.standings` computes it once — sort all by points, keep the
first three, sort the rest by `completionPct`, concatenate, stamp `rank` — and
returns it as `ranked`, read by BOTH boards.

**A points tie is broken by who EARNED it first (2026-10-19), then by passes.**
Before this, a points tie fell through to assessments-passed and then to raw DB
order, so two learners on the same points (e.g. both at 390, both with one
assessment passed) ranked arbitrarily — one with lower completion could sit
above one with higher. The tiebreak is now `lastEarnedAt` (the MAX `earned_at`
over their point events): the earlier finisher wins, which is deterministic and
matches what a reader expects. It applies to the podium AND the rest, and the
client re-derivation for the dept filter mirrors it (the API sends
`lastEarnedAt` per learner, used only for the sort, never displayed). The
podium is therefore still a points race (the highest points generally sit at
~100% completion anyway), while the long tail no longer shows a 0%-complete
learner above a 27% one. The previous rule said the board did NOT rank on
completion and warned against a second points calculation; that still holds — the
points SUM is unchanged and is the top-3 order and the completion tie-break, not a
parallel calculation. `completionPct` uses the SAME definition as the admin
analytics column (all lesson completions over the lessons in assigned courses),
so the number the rank is based on is the one already on screen.

The month board (`byMonth`, Learner of the Month) is unchanged — it is a
points-per-month race by design, and completion has no monthly form.

**`LeaderboardEntry` carries `avatarUrl` (standings selects `u.avatar_url`),
and the learner dashboard reuses `standings` for two Home cards** rather than
querying anew: `cohort_leaderboard` is the TOP 3 of `ranked` plus the caller's
own `{rank, points}` line, and `learning_with_you` comes from
`LearnerRepository.coEnrolledPeers` — other active learners org-scoped to the
caller who share a course assignment (session trainings and external-cert
courses excluded, one shared course per peer via DISTINCT ON). Both are
additive fields on `GET /learner/dashboard`; no new endpoint, no migration. The
client renders them in `dashboard-cohort-peers.jsx` and the per-peer "Say hi"
opens a direct-message thread (the Messages module, 0054).

**Presence (0055): `users.last_seen_at`, for the Messages "Available" dot.**
`PresenceInterceptor` (global `APP_INTERCEPTOR`, after the guards so
`request.user` is set) touches it on ANY authenticated request — throttled in
memory to once a minute per user, fired best-effort without awaiting (§8.4), so
a slow or failed presence write never delays the request. It is last-SEEN, not
last learning activity, so "Available" means around now. `MessagesService`
derives `online` (seen within five minutes) + `last_seen` for the thread peer
and the conversation list; the browser renders what it is sent and never decides
who is online. A hardcoded dot would be the screen that lies (§5.2.1) — this is
backed by a real column.

**`GET /learner/dashboard` also gained `streak`, `certificates` and
`points_this_month`** for the Home "at a glance" tiles — additive, no new
endpoint. `streak` is the consecutive-local-day count from
`LearnerRepository.activityDates` (distinct days with a lesson completion or an
assessment attempt, `submitted_at` on attempts — NOT `created_at`, which that
table lacks); `certificates` is `{count, latest}` reused from
`CertificatesService.listForLearner`; `points_this_month` is the standings'
`monthPoints`. The streak is real activity, never a fabricated counter.

### 10.5.1 The points model: the reference's rules, minus community

`modules/leaderboard/points.ts` holds the numbers and the readable catalogue
(`POINT_RULES`, served as `pointRules` on `GET /learner/leaderboard` and
rendered as the "How Points Work" tab). Nothing in the browser holds a rate.

| Rule | Points | Paid when |
|---|---|---|
| Course completed | 100 | every active lesson of a course done |
| Assessment passed | 50 | best PASSING score below 90% |
| Top score | 150 | best passing score 90–99% |
| Perfect score | 200 | best passing score 100% |
| Feedback submitted | 15 | each `course_feedback` / `session_feedback` row |
| Finished early | 75 | course completed on or before assigned_at + `DUE_DAYS` |
| Session attended | 40 | present / late / partial on a session marked completed |
| Learning path completed | the path's `points_bonus` | `journey_enrollments.completed_at` set |

Changed 2026-10-06 at the owner's request, to match the reference design. It
replaced `lessons x 10 + DISTINCT passes x 50 + path bonus`, which reshuffled
the board. The four community rules (post, answer, marked helpful, accepted
answer) are left out because there was no community feature — add each in the
change that builds what triggers it. Still true (2026-11-20): the Learning
Community has since shipped (§10.35) and kudos are deliberately NOT points
(§10.40); no community rule pays points yet.

**`pointEvents()` is the one definition, and it has two readers.** The
standings SUM it, in the same round trip as the rest of the row; the
Achievements points history LISTS it (`LeaderboardService.history`). A
history written as its own query would stop adding up to the board the first
time a rule moved. Every branch carries `orgScope` on its ACTIVITY table, not
on the content — §10.12's rule.

Decisions worth knowing before changing one:

- **The three score rules are tiers, not a stack.** One per assessment, from
  the best PASSING score, so re-sitting from 72% to 95% upgrades 50 to 150
  and re-sitting within a band pays nothing — the farming DISTINCT used to
  prevent stays prevented. The reference stacks them (a 100% earns
  50+150+200); the owner specified bands. "Passing" is the assessment's own
  `is_passed`, not a fixed 60%.
- **Lessons no longer pay on their own.** The reference pays for finishing a
  course; paying per lesson as well would let a course with many short
  lessons outscore a harder one with few.
- **"Early" is the Quick Learner badge's own test** (`BadgesRepository`), so
  the bonus and the badge cannot disagree. It uses `DUE_DAYS`, not
  `user_course_assignments.due_date`, because that is the date every learner
  screen prints.
- **A session's companion course pays attendance, never completion** — the
  sitting is the thing done. Attendance needs the session marked COMPLETED,
  which is also when it credits the training (§10.7), so the 40 and the card
  move together.
- **An approved external certification pays nothing.** It counts as a
  completed course for hours and analytics (§10.26), but 175 points for
  training this platform did not deliver would put it on a board learners
  compete on. Stated in `POINTS_NOTES` so nobody has to guess.

The course cards price themselves with `courseReward()` from the same file:
`totalPoints` is the guaranteed figure (completion, the early bonus while it
is winnable, the pass rate per assessment) and `maxPoints` what perfect
scores would pay.

### 10.4.1 Partial SCORM progress feeds the course percentage (0048)

A course whose only lesson is one big SCORM package used to read **0% until
the package reported itself finished**, because course progress is
`completed_lessons / total_lessons` and that single lesson is binary. A learner
two sections into a ten-section package saw nothing move.

`scorm_tracking.progress_measure` (0..1, nullable) fixes it. It is written at
tracking time by `scormProgressMeasure()` from, in order: a finished status
(1.0), SCORM 2004's standard `cmi.progress_measure`, or — best-effort for 1.2,
which has no progress field — a recognised `suspend_data` completion bitfield
(`{"c":"1100…"}`, the share of 1s). Any unrecognised shape stays NULL and the
lesson stays binary, so a package from another authoring tool is never given a
wrong number.

**One definition, read in four places.** `courseProgressPct(total, done,
partial)` in `learner.service.ts` adds the sum of in-progress SCORM fractions
to the completed count, capped at 99 until every lesson is genuinely done — so
100% still means done, and completion / certificates still decide that on
`done >= total`, never on this figure. My Courses and the dashboard read
`assignedCourses.scorm_partial`; the course detail reads
`scormPartialForCourse`; My Progress reads the same stored column (its old
inline `cmi_data` re-parse, which caught only 2004, is gone). All four agree.

**Hours were already partial and are unchanged.** §10.4 below already credits
an in-progress SCORM lesson from the package's reported `total_time` (capped at
the declared duration), so time and percentage both advance as the learner
works — they just measure different things (minutes spent vs. content covered).

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

Extracted packages are served at `/scorm/<uuid>/...` (outside the `/api`
prefix). Superseded (2026-11-20): they no longer live in
`server/storage/scorm/` behind `useStaticAssets`; they are in R2 and streamed by
`ScormContentHandler` after `ScormContentMiddleware` authorizes the request
(§10.9). The proxy reasoning below is unchanged.

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
  before flipping the switch in production. **Done:** `scripts/migrate-scorm-to-r2.mjs`
  did that, and the local driver and the switch were then removed (§10.9).
- `TokenService` can move to `@nestjs/jwt` once §10 reaches zero pending
  modules and the legacy verifier is deleted (§6.4).
- ~~Rate-limit the public verify endpoint.~~ ~~Add security headers.~~ **Done, without either library: see §10.47.**

### 10.34 Public UUIDs in URLs, without touching the primary keys

`0046_public_ids.sql`. A sequential integer primary key in a browser URL
(`/my-courses/47`, `/scorm-player/30`) leaks two things: roughly how many
records exist, and a guessable neighbour to probe. Authorization already closes
the door on reaching another tenant's row — every handler is org-scoped and
ownership is checked in the service, so a guessed id 404s (§5.3) — so this is
**enumeration hardening, not an open IDOR fix**. The severity is moderate; the
public identifier simply should not be guessable, and the integer one is.

**The fix is ADDITIVE, and that is the whole decision.** The integer primary
keys and every foreign key stay exactly as they are — they are what joins and
tenancy predicates run on, and converting them would rewrite every table and
every one of the 85 handlers. Instead each table whose id appears in a URL gains
a second, non-sequential `public_id uuid`. The URL and the public API name a
record by it; the database still joins on the integer underneath.

**Seven tables carry it**, the ones whose id appears in a browser URL: `courses`,
`lessons`, `assessments`, `scorm_packages`, `sessions`, `organizations`,
`certificates`. (`scorm_packages.package_dir` is a SEPARATE on-disk UUID — do
not conflate the two.) The column is declared in the Drizzle schema with
`.defaultRandom()` plus a `*_public_id_key` unique index, and in the migration
with `DEFAULT gen_random_uuid()` (core in pg 13+, so no extension).

**The migration is the first two of a THREE-step rollout** (the shape to repeat
for any column that must become NOT NULL on a live table):

1. add the column NULLABLE, with a DEFAULT so every new row is born with one;
2. backfill every existing row (idempotent — only rows still NULL);
3. **a LATER migration**, after the app reads and writes `public_id`
   everywhere, runs `SET NOT NULL`. Deferred so the migration can never fail on
   a row the app has not learned to populate, and so rolling the app back does
   not strand a NOT NULL column it cannot fill. **That enforce migration is not
   written yet.**

**`PublicIdService` (`src/database/public-id.service.ts`) is the one bridge, and
it accepts EITHER form.** `resolveIdOrThrow(table, param)` passes an integer
straight through and looks a UUID up; a controller takes the URL param as a
`string` and asks it for the integer id. Accepting both is what makes the
rollout non-breaking: every existing integer caller keeps working the instant
this ships and before the client has switched, and a client link that still
emits an integer is wrong only cosmetically, not functionally. It is provided
by `DatabaseModule` (global), so any controller injects it like
`DatabaseService`.

- **Resolution is deliberately UNSCOPED.** `public_id` is globally unique, and
  the downstream service still applies its own org-scope and ownership checks —
  so a guessed UUID that resolves to another tenant's row is refused there
  exactly as a guessed integer already is. Resolving an id does not grant access
  to it.
- **The table name is a WHITELIST**, never caller input, so naming the table
  dynamically in the query has no injection surface.

**Which routes resolve it: only the ones a browser URL reaches.** The learner
course/lesson/assessment/SCORM routes, the learner media routes (a lesson's
media is fetched with the lesson's URL id), the trainer session routes, the
platform organization routes **and** the delegated `:organizationId` roles/users
routes (they mint an `OrgScope` via `scopeFor`, so the id is resolved before
that), and the learner certificate detail route. The admin surfaces
(`/admin/courses`, `/admin/sessions`, `/admin/scorm`, …) are left on integers on
purpose — their pages carry no id in the browser URL, so hiding it there would
be cost without benefit.

**Responses expose `public_id` so the client can build the next link.** Where a
read already does `SELECT *` / `l.*` / `a.*` the column rides along for free
(the course detail's course, lessons and assessments); elsewhere it is added to
the column list (the My Courses list, the SCORM list/detail, the lesson payload's
own and next-lesson ids, the SCORM package id on a lesson, the org lists, the
certificate list and the My Courses certificate deep-link id). Watch the casing
trap §10.10 records: a Drizzle `.select()` returns `publicId`, a raw-SQL read
returns `public_id`, and the client reads whichever that endpoint already uses.

**Production rollout** is the standard one and is NOT done ad-hoc over SSH: a
`pg_dump` first (`/home/ubuntu/db-backups/`), then the backend deploys and 0046
backfills on boot, then the client. The `SET NOT NULL` enforce migration is a
later, separate deploy once the client emits only UUIDs.

---

### 10.35 Learning Community

`0049_community.sql` adds a per-organization social space; `0050_community_permission.sql`
grants the one new permission. Three tables, one toggle. Read the migration
headers first — the summary:

**It is ACTIVITY, so `orgScope` on EVERY read, never `contentScope`.** A post,
reply or like belongs to one tenant and never crosses the boundary — the exact
leak class §10.12 records. `community_posts`, `community_replies` and
`community_reactions` all carry `organization_id`, and every query in
`CommunityRepository` applies `orgScope`. This is the module whose isolation
matters most, because the content is user-written and visible to peers; the
isolation test must cover the feed, the detail, replies and likes.

**One post, three TYPES, chosen before composing** — `question` | `achievement`
| `discussion`. The type drives the UI (a question gets a **Contribute** button;
an achievement/discussion gets **Like + Comment**) but not the storage: there is
ONE `community_replies` table serving a question's contributions AND an
achievement/discussion's comments, relabelled by `post.type` in the client, so
there is one engine to keep in sync rather than two that drift. An achievement
post references a `certificate_id`; the course/path name is captured into
`title` at share time so the feed never has to join the certificate tables, and
the certificate's `public_id` is carried only for a "view certificate" link.

**Likes are `community_reactions`, shaped for posts now and replies later.** The
"exactly one of" pattern (§10.11): `post_id`/`reply_id` with a CHECK that one is
set and partial unique indexes on each — so v1 likes a post, and answer
up-votes (v1.1) are a column already present, not a migration. The `ON CONFLICT
(post_id, user_id) WHERE post_id IS NOT NULL` must repeat the partial index's
predicate (§10.26). Counters (`reply_count`, `like_count`) are denormalised and
recomputed with `SELECT COUNT(*)` inside the same write, so the feed never
counts rows per card (§7.1) and the counters cannot drift.

**Who-liked list (2026-10-19): `GET /learner/community/:postId/likes`** returns
the people who liked a post, newest first, as first name + last initial (the
§10.24 relaxation, the same `authorColumns` the feed uses) — org-scoped on the
reaction so a like never crosses a tenant. The learner UI splits the footer
control: the heart toggles the like (POST/DELETE `:postId/like`), and the count
text ("N Likes") opens a "Liked by" dialog backed by this read.

**Delete is SOFT** (`deleted_at`, `deleted_by`), for the author and for a
moderator. The row stays for audit and is hidden everywhere (`deleted_at IS
NULL` on every read); removing a post hides its replies with it. The author
deletes their own (ownership checked in the service, 403 vs 404, §5.3); an admin
deletes any — and the author is told, `community_post_removed`, naming only "a
moderator".

**`community_posts.public_id`** is the URL identity (§10.34), added to
`PublicIdService`'s whitelist; replies are addressed by integer id. The feed is
**keyset-paginated** (`(created_at, id) <` a base64 cursor), newest first;
the admin moderation read is limit/offset with a type filter and search.

**Permissions.** Learner participation carries NO permission — posting, liking
and replying are not capabilities an org grants (like the bell and surveys), so
the learner controller is `@Roles('learner')` only. The whole module is instead
gated by **`organizations.community_enabled`** (default 1 = on), checked in the
service (`assertEnabled`) and editable by a tenant admin on the Organization
settings screen. The one new permission, **`moderate_community`**, gates only
the admin DELETEs; the admin READ is open to the admin audience (§5.2.1). The
grant migration bumps `perm_version`, signing admins out once (§10.17).

**Notifications.** A new reply tells the post's author (`community_reply`,
bell-only, `email: 'none'`) unless they replied to themselves (`exceptUserId`).
A moderator removal tells the author (`community_post_removed`). Both are
best-effort (§8.4). Author identity on learner-facing surfaces is **first name +
last initial** (the §10.24 relaxation), full name only on the admin read.

**Known, deliberately out of v1:** answer up-votes (the reactions table is
ready), post editing beyond `edited_at`, a report-abuse flow, and auto-hiding
the learner nav entry when the org disables the module (the entry shows and the
page renders a clean "turned off" state, because `/api/auth/me` does not yet
surface org feature flags — surfacing it there is the small follow-up).

---

### 10.36 Referrals

`0051_referrals.sql` adds a per-organization referral program; `0052` grants the
one new permission; `0053` lets the outbox carry a non-user email. An org admin
refers another COMPANY to become a Spectra customer and earns a tiered discount
once a referral converts. Read the migration headers first — the summary:

**It is the Edstellar Services shape (§10.14) a second time.** A tenant files a
row, a `@PlatformAdmin()` queue manages it cross-tenant, and only the platform
side moves the status. So: `referrals` is ACTIVITY (`orgScope` on every tenant
read, never `contentScope` — the referral belongs to the REFERRER); `ref_no` is
`REF-YYYY-NNNN`, per-org, from the highest existing suffix; the tenant controller
(`@Roles('admin')` + `@Permissions('manage_referrals')`) has no route that writes
`status`; the platform controller (`@PlatformAdmin()`) is the only writer and is
a separate route tree, never a widening of the tenant one.

**`manage_referrals`** is a new permission with guards on both tenant routes in
the same change (§5.2.1). Separate from everything else for the same reason as
`request_services`: it reaches OUTSIDE the tenant (a prospect's details, an email
on Edstellar's brand). `0052` grants it to `is_system` admin roles and bumps
`perm_version`, signing admins out once (§10.17).

**THE REWARD TIER IS DERIVED, NEVER STORED.** 2 converted referrals earn 15%,
3 earn 25% (`common/referral-rewards.ts`, catalogue-as-code). `referralTier()`
reads `COUNT(*) WHERE status='converted'` per org at read time — no discount
column that a job has to keep in step (§10.17). The discount is SHOWN as earned;
applying it to billing is a deliberate platform action, not an automation. The
tenant `GET` returns `reward` in the same read as the list so the showcase banner
cannot disagree with it. `client/lib/referral-rewards.js` mirrors it.

**First-touch attribution.** A prospect email is globally unique
(`idx_referrals_contact_email` on `LOWER(contact_email)`); a second org referring
the same address gets a 409. Relaxable later if the business wants it.

#### Emailing a non-user prospect — the one genuinely new capability

The outbox was user-id driven: `enqueue` takes `userIds[]`, resolves `to_email`
from a `users` join, and `email_outbox.user_id` was `NOT NULL` FK to `users.id`.
A referred prospect has no account, so the invite needed a small extension that
KEEPS durability (the outbox is the message store, §10.30 — an invite cannot be
recalled):

- `0053` makes `email_outbox.user_id` nullable (additive; FK and cascade kept).
- `EmailOutboxService.enqueueDirect({ toEmail, ... })` writes a ready-to-send
  row directly (user_id NULL), bypassing the user-row `recipients()`/preference
  gate but still honouring the ADDRESS-level gates: the suppression list and
  `EMAIL_ALLOWLIST` (so a non-production environment cannot email a real
  prospect). Dedupe is keyed on the address, not a user id.
- `referral_invite` is a new `DIRECT_EMAIL_TYPES` entry with `account: false`,
  which the renderer reads to give it its own `cta` ("Discover Spectra LMS") and
  a neutral "{org} shared Spectra LMS with you" footer rather than the "security
  message" one. Its group is `referral` (a new `GROUP_STYLE` entry, accent blue,
  eyebrow "Invitation"). The CTA link is relative (`/`) so it resolves to the
  public Spectra origin — deliberately NOT a sign-in or onboarding link, because
  the invite creates no account (confirmed with the owner).
- `EmailRenderService.render` now splits `body` on blank lines into paragraphs
  (a no-op for every existing single-sentence body), so the invite carries its
  pitch and a facts panel.

Verified end to end against the local API: create → 201 + `REF-` ref_no; the
invite enqueued as a direct row (`user_id` NULL, `to_email` the prospect,
`org_name` the referrer, status pending) and RENDERED correctly for the null-user
row; the platform notified (`referral_received`, bell only, no email); the tenant
list carries the reward tier; a duplicate prospect → 409; a learner → 403 on the
admin route; the platform queue includes it with the referrer named; convert →
200, the referrer notified (`referral_converted`) and the tier recomputed; a
tenant admin → 403 on the platform route.

**Notifications.** `referral_received` (platform, bell only — Edstellar works the
queue) on create; `referral_converted` (admin, transactional) to the referrer on
the TRANSITION into converted only, so re-saving a converted referral does not
re-ring the bell. Both best-effort (§8.4), beside a `referral_submitted` activity
entry for the referrer's dashboard.

**Integer ids in URLs**, not `public_id` — the admin and platform screens carry
no id in the browser URL (mirror service_requests).

**Deliberately out of v1:** the earned discount is not wired into billing (shown
as earned, platform applies by hand); the invite CTA points at the Spectra app
origin rather than a dedicated marketing/landing URL (the renderer's `absoluteUrl`
confines links to the app origin — pointing at a public Edstellar page is the
noted follow-up); linking a conversion to a tenant provisioned in the same step
(v1 links via the platform respond dialog's org picker instead).

### 10.37 Self-enrolment emails, and the session meeting link (2026-10-15)

Self-enrolment (§10.25) wrote the assignment but, for the learner's own
confirmation, nothing or the wrong thing. Three gaps, all fixed, plus the
session emails learned to carry the sitting and the join link.

**Course self-enrol now confirms, and tells the admin.**
`CoursesService.selfEnrol` fired no notification at all. It now sends the
learner `course_self_enrolled` (transactional, "you added this yourself" — a
distinct type from `course_assigned`, which says L&D assigned it) and fires the
org's admins a bell.

**Session self-enrol was silently excluded from its own confirmation.**
`addToRoster` notifies `session_enrolled` with `exceptUserId: adminId`, and the
self-enrol path calls `addToRoster(.., userId, { user_id: userId })` — so the
enroller WAS the excepted "admin" and got nothing. `selfEnrol` now sends the
receipt explicitly (and `notifySelfWaitlisted` sends `session_waitlisted` when
the session is full). Both also fire the admins a bell.

**"Give up my place" now confirms.** `selfLeave` sent nothing; it now sends
`session_booking_cancelled` (leaving a place, or leaving the queue — one type,
two bodies), linked to the catalogue so they can rebook.

**The admin bell is ONE type, bell-only.** `self_enrolment` (audience
`['admin']`, `email: 'none'`) fires to the org's admins whenever a learner
self-enrols in a course or session, or joins a waitlist. `email: 'none'`
because self-enrolment can be high-volume and L&D wants it in the bell, not
filling their inbox — `EmailOutboxService` writes no outbox row for a `'none'`
policy. The learner's name rides as `actorName`.

#### Session emails carry the sitting and the venue, and the button joins

`SessionsService.sessionLearnerDetails` is the one place a learner's session
email is described — read by the admin-add, self-enrol and waitlist paths — so
"booked", "waitlisted" and "self-enrolled" cannot disagree about a sitting. It
builds the facts panel (Format, Date/Time as `start – end`, each **batch
sitting** listed when the session runs in sittings, Trainer) and decides the
place-vs-link rule from `session_type`:

- **Virtual** — `venue_url` is a meeting URL. It is shown as a copyable "Join
  link" fact AND returned as the email's `link`, so the button JOINS the
  meeting from the inbox.
- **In person (ILT)** — `venue_url` is a room. Shown as "Venue"; the button
  goes to `/my-sessions`.

The meeting-link button is the one place a notification `link` is allowed to be
an external URL. `EmailRenderService.ctaFor` whitelists exactly
`session_enrolled` (`SESSION_JOIN_TYPES`) and only when the link is a
well-formed http(s) URL (`isSafeHttpUrl`); every other type still goes through
`absoluteUrl`, which confines links to the app origin (§10.30's fan-out guard).
This is safe because that link is always the admin-set `venue_url`, never
learner input. The in-app bell was taught to open an external `link` with
`window.open` (it used `router.push`, which only handles internal routes), so
the same meeting link works from the bell too.

**No migration and no new table** — the three new learner types and the one
admin type are catalogue-as-code (`common/notifications.ts`), so a deploy needs
a **worker restart** (new notification/email catalogue entries) but no schema
change. Verified end to end against a real tenant (throwaway data, torn down):
course and session self-enrol each send the learner's email and the admins'
bell; a virtual enrol's email button is "Join the session" → the meeting URL
while an in-person one is "See my sessions" → `/my-sessions`; waitlist and
give-up-place both confirm; and `self_enrolment` writes no outbox row.

### 10.38 My Data — PDPA self-service

`0056_data_requests.sql` adds the "My Data" self-service: a data subject exports
everything the platform holds about them, and files a correction or deletion
request. It is the first of the Singapore-PDPA technical-readiness features (the
others, built alongside, are consent capture and admin MFA). Read the migration
header first; the summary:

**THE EXPORT IS STRICTLY THE CALLER'S OWN DATA.** Every read in
`MyDataRepository` is keyed by the caller's `user_id` (taken from the verified
token, never a parameter), and where a table has no direct user column
(`user_assessment_answers`) it is reached through a row that does. No select
list includes `users.password` or anything from `password_reset_tokens` — the
two genuinely sensitive columns never enter scope, the same discipline §3.1
names `...WithSecret` to enforce elsewhere. It spans ~22 user-keyed tables
(profile, assignments, completions, video progress, assessment attempts +
answers, SCORM assignment/tracking/attempts, certificates, journey enrolments,
badges, external certifications, session roster/waitlist/attendance, session +
course feedback, community posts/replies/reactions, direct messages,
notifications, email history + preferences), assembled into one machine-readable
JSON document (PDPA portability). It joins only to resolve the human-readable
name of the course / lesson / session a row points at.

**Two high-volume telemetry logs are deliberately EXCLUDED, and the export says
so in words.** `scorm_datamodel_log` (one row per SetValue, §10.9 calls it the
hottest write path) and `audit_log` are left out — the same reasoning §10.32
gives for the audit page: one row per keystroke buries everything a person can
actually read. An export that quietly omitted a category would be worse than one
that states what it omits, so the summary's `note` names the exclusion and says
they are available on request.

**The download reuses the reports exporter's header contract** — `Content-Type`,
`Content-Disposition`, and crucially `Access-Control-Expose-Headers:
Content-Disposition` so the cross-origin fetch in `client/lib/download.js` can
read the filename (§10.12 records why that header is load-bearing). It is a
`@Res()` route returning the JSON as a stream, the same shape as an xlsx export.

**A REQUEST IS LOGGED, NOT EXECUTED.** A correction or deletion writes one
`data_requests` row and touches nothing else. Deleting learning records reaches
certificates, hours, analytics and the audit trail, so a deletion is reviewed
and actioned by an admin — PDPA allows a reasonable process, not an instant
self-service hard delete. Most profile fields are already self-editable
(§10.17's `UpdateProfileDto`); a correction request is for the learning records
that are not.

**ACTIVITY, so `orgScope` on the admin queue.** A request belongs to the
subject's org; the admin queue reads only its own tenant's (§10.12), and a PATCH
to a request in another org 404s exactly as a non-existent one does. There is no
cross-tenant view.

**No `@Roles()` on the subject's half.** Every authenticated person is a data
subject, so `my-data` serves learners, trainers and admins alike — the same
reasoning as change-password and the email-preference routes. The subject is
always the caller, so no route takes a user-id parameter.

**No new permission.** The admin queue read reuses `view_employees` and the
write `manage_users`, so deploying this does not bump `perm_version` or sign an
organization out (§10.17). Actioning a correction/deletion is the same weight as
managing a user.

**Filing a request now notifies both sides** (added after the first slice).
`MyDataService.notifyOnCreate` fires, best-effort (§8.4): `data_request_received`
to the org's admins (`NotificationsService.adminsOf`, excepting the requester),
and `data_request_submitted` to the subject. Both are transactional (bell +
email), two new catalogue types in `common/notifications.ts`. The admin email
names the person, department and request type, quotes their description, and
carries a facts panel; the subject's email confirms the request is under review,
explains why the data is held and how it is used, and links the privacy notice
(`PRIVACY_POLICY_URL`, a `#` placeholder until the page exists). `MyDataModule`
imports `NotificationsModule` for this, so a deploy needs a **worker restart**
(new catalogue types) but no schema change.

Routes:

```
GET  /api/my-data                      summary: subject + per-category counts
GET  /api/my-data/export               the full JSON download
GET  /api/my-data/requests             the caller's own requests
POST /api/my-data/requests             file a correction/deletion request (201)
GET   /api/admin/data-requests         the org's queue + counts   (view_employees)
PATCH /api/admin/data-requests/:id     action one                 (manage_users)
```

Verified end to end against the running API: a learner's summary returned real
counts, the export streamed 24 KB of JSON with the right `Content-Disposition`,
a deletion request was filed and listed; a learner got 403 on the admin route,
the admin (same org) saw the request with the subject named, a PATCH recorded
the handler and the learner saw the new status; a cross-org id 404'd and an
invalid type 400'd. The test row was removed afterwards.

### 10.39 Consent capture and admin MFA

Two more Singapore-PDPA readiness features, both on the auth module.
`0057_user_consent.sql` and `0058_user_mfa.sql` — read each migration header.

#### Consent (0057)

`users` gains `consent_version` and `consented_at`, both nullable, no backfill.
`PublicUser` gains `consent_required`, computed by `isConsentRequired()`
(`common/consent.ts`) on every read that builds one — login, `/auth/me`, the
MFA-verify issue, and exit-impersonation. The rule is one place: NULL
`consented_at`, or a `consent_version` that is not `CURRENT_PRIVACY_VERSION`,
means consent is owed. So raising that constant re-prompts everyone with no
migration.

`POST /auth/consent` records the current version for the caller and returns
their refreshed identity. No `@Roles()` — every portal gates on it, identity is
the token's, so a caller only ever consents for themselves. A support session
reports `consent_required: false`: making a platform admin accept a tenant
user's notice inside a borrowed account is not consent by anyone.

The client is the authority on the NOTICE COPY (a product/legal artifact); the
server only records acceptance and says whether it is owed.

#### Admin MFA — TOTP (0058)

> Superseded in part (2026-11-20): this subsection describes the first,
> admin-only, app-only version. Since §10.49 two-step sign-in is mandatory for
> admin-portal accounts and optional for everyone, and the MFA routes are open
> to every role (`POST /auth/mfa/disable` refuses an admin). Since §10.51 a
> person may use an authenticator app OR an emailed code, so
> `MFA_ENCRYPTION_KEY` gates only the app method. Read those sections for the
> current behaviour; the route list below shows the original audiences.

`user_mfa` (one row per enrolled user): the TOTP `secret` ENCRYPTED with
AES-256-GCM under `MFA_ENCRYPTION_KEY` (`common/crypto/secret-box.util.ts`),
`enabled_at`, and `recovery_codes` (jsonb of `{hash, used_at}`, SHA-256 hashed,
shown once). `otplib` + `qrcode`.

**ENROLLED vs ENABLED is the safety.** `setup` stores the secret with
`enabled_at` NULL (pending) and returns the QR; `enable` verifies a first code,
sets `enabled_at` and mints recovery codes. Only an ENABLED row makes login
challenge, so a secret the user never scanned can never lock them out.

**The login flow is two-step for an MFA admin.** `AuthService.login` returns a
union: the normal `AuthResult`, or `MfaChallenge { mfaRequired, mfaToken }` when
the password is right and the account is an admin with MFA enabled. On the
challenge path **no cookie is set** — the controller returns `{ mfa_required,
mfa_token }`. `POST /auth/mfa/verify` (`@Public`, authorised by the short-lived
challenge token, not a session) checks the TOTP or a single-use recovery code
and only THEN issues the real session. The challenge token
(`TokenService.signMfaChallenge`, 5 min) carries only a user id and org — no
role, permissions or scope — so it can authorise nothing on its own.

**MFA is admin-scoped.** SUPERSEDED by §10.49 (2026-11-18): two-step
sign-in is now mandatory for admins and optional for everyone else, and the
login challenge applies to anyone who has it on.

**`MFA_ENCRYPTION_KEY` is optional at boot** (warn-and-degrade like R2/email):
absent, `MfaService.isConfigured()` is false, `isEnabledForLogin` returns false,
and the enrolment routes 503. Since nobody can enrol without the key, login is
unaffected until it is set. **It must be added to the box's `.env` by hand before
the deploy that needs it** (§9 — config is read once at boot), and must never be
lost or rotated casually: losing it makes every stored secret undecryptable and
locks out every MFA admin (recovery codes remain the way back in).

Routes:

```
POST /api/auth/consent                 record consent        (any role)
GET  /api/auth/mfa/status              enrolled/enabled      (admin)
POST /api/auth/mfa/setup               begin enrolment + QR  (admin)
POST /api/auth/mfa/enable              confirm + recovery    (admin)
POST /api/auth/mfa/disable             turn off              (admin)
POST /api/auth/mfa/verify              login 2nd factor      (@Public, challenge token)
```

Verified end to end against the running API (22/22): consent owed at first
login, cleared by `POST /auth/consent`, reflected on `/auth/me`; MFA setup →
QR, wrong enable code 422, enable returns 10 recovery codes, login then returns
`mfa_required` with no cookie, verify by TOTP and by recovery code both issue a
session, a spent recovery code is refused, disable returns login to normal.

### 10.40 Community kudos and hashtags

Two additions to the Learning Community (§10.35), both built on the ONE engine
rather than beside it. `0059_community_kudos.sql` and `0060_community_hashtags.sql`.

#### Kudos — a kudos IS a post

A kudos is a `community_posts` row of `type = 'kudos'` with a new
`recipient_user_id` (0059), nothing more. The giver is `user_id`, the message is
`body`, there is no title. That reuse is the whole design: a kudos rides the
existing feed, likes, replies, soft-delete and moderation with no parallel
table, and My Courses-style "teach nothing new" means the feed card, the bell
and the admin moderation feed all pick it up through code that already works.
`type` is plain text validated per route, so 'kudos' needed no enum change.

- **`giveKudos` validates the recipient is an ACTIVE learner-portal account in
  the caller's org** (`isKudosRecipient`, joined to `roles.portal = 'learner'`,
  `orgScope`), and not the caller. A cross-tenant or non-learner id resolves to
  nothing and returns 404 — not 403 — so the id cannot probe who exists
  elsewhere. "Any employee including managers, regardless of role" means the
  community audience: a Manager rides the learner portal and so qualifies; an
  admin/trainer is not in the community and is not a recipient.
- **The Kudos leaderboard is SEPARATE from the points board** (owner's call):
  `kudosLeaderboard` ranks recipients by `COUNT(*)` of non-deleted kudos,
  org-scoped. Nothing touches `LeaderboardRepository.pointEvents` — kudos is
  recognition, not a gameable point source (§10.5.1).
- **People and kudos surfaces show first name + last initial** like the rest of
  the community (§10.24), EXCEPT the picker search (`searchPeople`), which shows
  the full name + department because the giver is choosing a specific person and
  two "Priya"s must be distinguishable; that read is private to the giver.
- **`kudos_received` is a new notification type** (`common/notifications.ts`,
  group `recognition`, `transactional`) — a deploy needs a **worker restart**
  (new catalogue entry) but no migration beyond 0059/0060.

#### Hashtags — normalised, required, trending

`community_hashtags` (per-org, unique normalised `tag`, first-seen `label`,
`usage_count`) and `community_post_hashtags` (0060).

- **Normalisation is the feature** and lives in ONE shared place,
  `common/community-hashtags.ts` (mirrored by `client/lib/community-hashtags.js`):
  strip the `#`, keep letters/digits/underscore, lower-case. `#Renewables`,
  `renewables` and ` Renewables ` collapse to the one stored tag, so a tenant
  never gets case-duplicates. `label` keeps the first casing for the chip.
- **Every post requires at least one** (question / achievement / discussion);
  **kudos is exempt** (the spec's four categories do not include it, and a kudos
  has no title to tag). The service merges the chip input with any `#tokens`
  typed inline in the title/body, de-duplicates, and 400s an empty result.
- **Reuse, not duplication:** `upsertHashtags` is one `INSERT ... VALUES (…) ON
  CONFLICT (org, tag) DO UPDATE usage_count + 1` (not one round trip per tag),
  and `linkPostHashtags` is one multi-row insert (§7.1). Autocomplete
  (`suggestHashtags`, prefix match ordered by `usage_count`) reuses existing
  tags so the chip input never mints a near-duplicate.
- **Trending reads the LIVE join**, not `usage_count`: top tags by count of
  non-deleted posts in the last 30 days. `usage_count` is only an autocomplete
  popularity hint and is deliberately not decremented on a post's soft-delete —
  a deleted post drops out of trending and of the hashtag feed filter
  (`feedFor` joins against `deleted_at IS NULL`) regardless.
- **The feed filter is `?hashtag=`** on the existing feed read, normalised the
  same way before matching, org-scoped on the hashtag row. A post's hashtags
  ride on every post read as a `json_agg` of `{tag,label}` (`[]` when none), so
  the feed, the detail and the card never disagree and never need a second query.

New routes, all on `learner/community`, the static ones declared BEFORE
`:postId` so Express does not capture them as a post id:

```
GET  /people                 people search for the kudos picker
POST /kudos                  give kudos (201)
GET  /kudos/summary          the caller's own received (count + recent), for My Profile
GET  /kudos/leaderboard      most kudos received
GET  /hashtags?q=            autocomplete
GET  /hashtags/trending      trending (30 days)
GET  / (…&hashtag=)          the feed, now filterable by tag
```

No new permission (participation is not an org-granted capability, §10.35), and
the whole module stays gated by `organizations.community_enabled`.

### 10.41 Community: admin-curated discussions, and Groups

`0061_community_groups.sql`. Two changes to the Learning Community: the
Discussion type becomes admin-only, and Groups (admin-created sub-communities) are
added. Both reuse the one engine rather than a parallel system.

**Discussions are admin-curated.** A learner's `createPost` rejects
`type='discussion'` (403, with a sentence pointing them at asking a question or
replying). Admins create discussions via `POST /admin/community/discussions`
(`moderate_community`), which forces the type, requires a hashtag like any post,
and may target a group. Learners still VIEW and REPLY to discussions — only
starting a thread is restricted. The learner composer drops the Discussion
option; the "Discussions" filter tab stays (for viewing).

**A group is an admin-created sub-community a learner joins, with its own feed.**
`community_groups` (name, description, `public_id`, soft-remove `archived_at`)
and `community_group_members`. A post carries a nullable `community_posts.group_id`:
NULL is the main feed, set is that group's feed — **a post lives in exactly one
place**, so the main feed is `group_id IS NULL` and a group feed is
`group_id = X`. Kudos and the achievement/question composer all stay in the main
feed unless posted from inside a group.

- **Reading a group feed is open to the org; POSTING requires membership**
  (checked in `createPost`). Joining is self-serve (`POST
  /learner/community/groups/:id/join`), no permission — participation is not an
  org-granted capability (§10.35). An admin curates a group's discussions
  WITHOUT joining it.
- **Group CRUD is `moderate_community`** (the same permission as moderation —
  curating and moderating go together, no new grant migration, §10.40's choice).
  Archive is the soft-remove; there is no hard-delete route (the FK cascade
  exists only as a safety).
- **Id exposure follows §10.34's split:** a learner addresses a group by its
  `public_id` (it rides in `?group=` and the join routes, resolved via
  `PublicIdService` — `community_groups` is now whitelisted); the ADMIN screens
  use the integer id, because they carry no id in a browser URL. So
  `adminListGroups` returns the integer id while `listGroups` (learner) returns
  the `public_id`. The learner's post `groupId` is a public id resolved in the
  controller; the admin's is an integer.

New routes:

```
# learner
GET    /learner/community?group=<public_id>     a group's feed (org-readable)
GET    /learner/community/groups                browse + joined state + counts
POST   /learner/community/groups/:id/join       join (200)
DELETE /learner/community/groups/:id/join       leave
POST   /learner/community                        groupId (public id) → posts into a group (member only)

# admin  (moderate_community on the writes)
GET    /admin/community/groups                  manage list (incl. archived), int ids
POST   /admin/community/groups                   create (201)
PATCH  /admin/community/groups/:groupId          rename / describe / archive / restore
POST   /admin/community/discussions              create a discussion (201), optional group
```

The static admin and learner group routes are declared BEFORE `:postId` so
Express does not capture them as a post id. No new permission; still gated by
`organizations.community_enabled`.

### 10.42 Sharing files: community Resources and DM attachments

`0062_shared_attachments.sql`. Two surfaces gain file sharing — a community
**Resource** post (a link OR a PDF/image file) and a **direct-message
attachment** — over ONE shared file store.

**One store, two callers.** `SharedFileService` (`modules/files`, a
dependency-free module both import) writes to `UPLOAD_STORAGE_PATH/shared/` with
UUID names, exactly the external-cert disk pattern (§10.26) and for the same
reasons: the bytes are private (served only through an authenticated route that
checks the caller), and R2 is optional config so a local disk is what always
works. `common/shared-files.ts` is the one allow-list + sniffer: **PDF and
raster images only** (PNG/JPG/WebP/GIF), magic-byte verified, 15 MiB cap (under
the 20 MiB nginx origin body limit). NOT SVG (script-carrying XML on our origin,
§10.10) and NOT Office docs (zip containers whose bytes cannot be told apart —
share those as a LINK). `store()` validates type → size → magic bytes, then
writes; a failed row discards the file (§10.26's rollback).

**A Resource is a post type**, so it rides the whole community engine. Columns on
`community_posts` (0062): `resource_url` for a link, or `file_path/name/mime/size`
for a file (exactly one). It is created via `POST /learner/community/resources`
(multipart, learner-creatable — unlike discussions) with a title, a link OR a
file, and a hashtag like every post; `file_path` is never selected into the feed
(internal), and the file streams from `GET /learner/community/:postId/file` after
an org-scope check (a resource is shared with the whole community). v1 is
main-feed only (not into a group). The composer and the "Resources" filter tab
are new; `resource` is in `FEED_FILTER_TYPES` but NOT `COMMUNITY_POST_TYPES`, so
the JSON create cannot mint one without a file.

**A DM attachment** is `file_path/name/mime/size` on `direct_messages` (body
stays NOT NULL — an attachment-only message has an empty body). `POST
/learner/messages/:userId` is now multipart (body OR file required); the file
streams from `GET /learner/messages/attachments/:messageId/file`, entitled to the
message's **sender or recipient only** (checked in the service, §5.3). Links in a
message already render clickable (Linkify), so the new capability is files.
Attachment file sends are NOT optimistic on the client (no local URL to preview);
text-only sends keep the optimistic+Retry path.

Both download routes set `Content-Disposition: inline` + `Access-Control-Expose-Headers`
(§10.12). The client builds the file URL from `SERVER_URL` and the id; the auth
cookie rides along because the API is same-site (shared parent domain), so an
`<img>` or a top-level open carries it.

### 10.43 Retention sweep (PDPA #7 — Retention Limitation)

`0063_user_retention.sql`. A deactivated user's PII was kept indefinitely; this
adds a scheduled sweep that ANONYMISES it after a window. The PDPA gap analysis
(scenario #7) is the driver. Read the migration header first; the summary:

**It ANONYMISES, it does not delete.** The `users` row stays so certificates,
completions, attempts and roster rows keep their foreign key; every PII column
is stripped (`first_name`/`last_name` → tombstone, `email` →
`deleted+<id>@retention.invalid` so the UNIQUE holds, `password` → a value that
is not a valid scrypt `<hex>.<hex>` so it can never verify, and
phone/avatar/location/job_role/job_level/employee_id/consent nulled).
`anonymized_at` is set so a row is swept once. A hard delete would cascade
across ~20 tables and destroy the aggregate history the product reports on;
anonymisation satisfies the obligation without that.

**TWO guards, both off by default, because it is irreversible.**
`RETENTION_ENABLED` must be `true` or the daily job is a no-op, and
`RETENTION_DRY_RUN` must be `false` or it only COUNTS and logs what it would do.
The intended rollout is: enable, watch the dry-run count in the worker log for a
few days, then turn dry-run off. Defaults in `config/configuration.ts`
(`retention.*`).

**The clock is `users.deactivated_at`**, stamped by `UsersRepository.setActive`
on deactivation and cleared on reactivation (so a re-enabled account is never
swept). Existing inactive users had no such timestamp and there is no
`updated_at` to approximate one, so the migration backfills `deactivated_at =
now()` — the clock starts at DEPLOY, never retroactively, which cannot anonymise
a long-tenured user the moment this ships.

**Platform-org users are excluded.** The sweep joins `organizations` and skips
`is_platform` — a product operator is not a customer's ex-employee and does not
belong on the same schedule.

**Worker-only, on the cron.** `RetentionModule` is imported by `WorkerModule`
(not `AppModule`), and `PgBossService` schedules `retention-sweep` daily at
04:00 UTC — a quiet hour after the 03:00 prune, and free when disabled. No HTTP
surface, no new permission. The service batches the UPDATE (500 at a time) so
one run never holds an unbounded lock.

**Known follow-ups (not in this slice):** purge/anonymise of other PII that
outlives its purpose — old direct messages, read notifications, assessment
attempts for anonymised users — and a per-category retention policy. The
framework (`RetentionService` + `RetentionRepository`) is shaped to take more
categories; this slice does the deactivated-user case the gap analysis names.

### 10.44 Leaderboard privacy (PDPA readiness, gamification)

`0064_leaderboard_privacy.sql`. Three controls over what colleagues see on
the leaderboard, decided with the owner on 2026-11-17: visible by default with
a personal opt-out; names shown as first name + last initial by default, as an
organization setting; and an organization on/off switch.

**An opted-out learner keeps their points; only the RANKS leave them out.**
`users.leaderboard_hidden` does not filter the standings query. `standings()`
still returns every learner in `entries`, because `BadgesService.pointsFor`
reads points from there, and dropping someone would have zeroed their
points-based badges. `ranked`, `byMonth` and `recognition` are built from
`participants` (entries minus the hidden), and a hidden entry keeps `rank 0`.
Ranking everyone and then hiding a row was rejected: the gap in the numbering
would point straight at the person who asked not to be seen. The kudos board
applies the same filter in SQL.

**`publicRank()` is the one rule for whether a rank may be shown**: null while
the organization has the board off or the learner opted out. Home, Achievements
and the board read it, so they cannot disagree. `rankOf` / `rank_of` count
`ranked`, not `entries`.

**`name` vs `publicName` on a `LeaderboardEntry`.** `name` is the full name and
is for ADMIN screens only (an admin already sees the full record). Every
learner-facing surface must use `publicName`, built by `leaderboardName()` in
`common/leaderboard-privacy.ts` from `organizations.leaderboard_name_display`
(`initial` default, or `full`). Recognition cards carry both; the learner
service swaps in the public one.

**The switch refuses, like the community's.** `organizations.leaderboard_enabled = 0`
makes `GET /learner/leaderboard` and the kudos board answer 403 ("The leaderboard
is turned off for your organization"), `cohort_leaderboard` on the dashboard
becomes null, and rank-news notifications stop. Points and badges still accrue
and `GET /admin/leaderboard` keeps working; it reports `hiddenCount` so the admin
board is not mistaken for the full headcount.

**A bug fixed on the way past.** The weekly "You are #N on the leaderboard"
notification took N from the person's index in `entries`, which is database
order, not the board's order, so the bell could name a rank the board did not
show. It now reads `rank` from `ranked`.

Writes: the learner's own flag rides on `PATCH /api/auth/profile`
(`leaderboard_hidden`), because it is a choice about themselves; the
organization's two settings ride on `PATCH /api/admin/organization`
(`manage_organization`). No new route and no new permission, so no
`perm_version` bump. `leaderboard.service.spec.ts` pins the guarantees above.

### 10.45 Consent log, and withdrawing consent (PDPA / DPDP)

`0065_consent_events.sql`. Two gaps from the privacy review: consent was one
bundled "I accept" with no history, and there was no way to withdraw it in the
product. Read the migration header first; the summary:

**The notice screen is an ACKNOWLEDGEMENT, not consent to the core training.**
The employer runs workplace learning on its own basis (PDPA employment
purposes with notification, DPDP section 7 legitimate use, GDPR legitimate
interests / contract). Asking the person to "consent" to it made the consent
bundled and not freely given, and a withdrawal would have had to stop their
training. What the person genuinely chooses (leaderboard visibility,
recognition emails) is offered as separate switches. `users.consent_version` /
`consented_at` still drive the gate exactly as before (§10.39).

**`consent_events` is append-only history**: `acknowledged`, `choice_changed`,
`withdrawal_requested`, `withdrawal_resolved`, `withdrawal_rejected`
(`CONSENT_EVENTS` in `common/consent.ts`), with the notice version, a small
jsonb payload, where it happened (`source`), IP and user agent. Existing
acknowledgements were backfilled once (`source = 'backfill'`).

**`ConsentLogService.record()` awaits and throws, unlike the activity log
(§8.4).** It is the proof. `recordConsent` writes the log row BEFORE the users
row, so an acknowledged account without evidence cannot exist; the reverse
failure only re-shows the notice. The one best-effort caller is the public
unsubscribe link, because a mail provider's one-click POST must not fail.

**One writer per setting.** The notice screen saves a changed choice through
its own route (`PATCH /auth/profile`, `PATCH /auth/email-preferences`), and
those routes log `choice_changed` only on a REAL change. `POST /auth/consent`
records a snapshot of the choices beside the acknowledgement and applies
nothing. A support session is refused (403) so no row is written that nobody
gave.

**Withdrawal is a `data_requests` type, logged, not executed** (§10.38's rule).
Filing one writes `withdrawal_requested`; the admin closing it as resolved or
rejected writes the matching event on the TRANSITION only. The optional choices
are already instant switches, so the request is for the core processing, which
is the organization's decision (usually deactivation).

`ConsentModule` is dependency-free and exports the service only, so EmailModule
can import it without breaking its no-cycle property. The retention sweep nulls
`ip_address` / `user_agent` when it anonymises a user and keeps the rows.

```
POST /api/auth/consent    body { leaderboard_visible?, recognition_emails? }  (snapshot)
GET  /api/my-data/consent the notice version acknowledged + the consent log
POST /api/my-data/requests  type 'withdrawal' added
```

The export gains `privacy.consent_events` and the counts gain `consent_events`.
No new permission. `CURRENT_PRIVACY_VERSION` was NOT raised: the new notice
wording reaches existing users only when legal signs it off and the version
moves, which re-shows the screen to everyone.

### 10.46 Security incident register (data breach notification)

`0066_security_incidents.sql`. The privacy review found no breach process at
all. The written plan is the Incident Response Plan, `Spectra-LMS-Security-Policies`
document 05 (it absorbed the privacy pack's former document 10); this is the
register it runs on, in the platform portal at `/platform/incidents`.

**Platform data, so no tenancy predicate and no tenant route.** An incident can
span several organizations, the register names them, and only
`@PlatformAdmin()` reads it. A tenant learns of an incident through the notice
it is sent. Affected organizations are a join table; the timeline
(`security_incident_events`) is append-only and every write adds a line, so the
review can see what was known when.

**The clocks are DERIVED, never stored** (`common/incidents.ts`, pinned by
`incidents.spec.ts`): assessment 30 days from discovery; clients 24 hours from
discovery (our processor target, to be aligned with the DPA); GDPR and DPDP
72 hours from discovery unless assessed not notifiable; PDPC 3 calendar days
from the ASSESSMENT once notifiable; individuals "as soon as practicable". The
assessment time is stamped when the outcome changes, because the PDPC clock
runs from it. The browser renders the states the API sends.

**Notify clients** sends `security_incident_notice` (bell + email) to every
admin of every affected organization, one `notify()` per organization so each
row is filed under it. The type is in `UNSUPPRESSABLE`: a breach notice to a
controller is our legal duty and a preference must not swallow it. A
suppressed (bounced) address still gets nothing, as for any type. The first
send stamps `clients_notified_at`; a later one is recorded as an update.

```
GET   /api/platform/incidents[/options|/:id]
POST  /api/platform/incidents                    log one (201)
PATCH /api/platform/incidents/:id                field-by-field
POST  /api/platform/incidents/:id/notes          timeline note (201)
POST  /api/platform/incidents/:id/notify-clients bell + email (200)
```

New notification type, so a deploy needs a **worker restart**.

### 10.47 Rate limiting and security headers

**Rate limiting is a global guard written here, not `@nestjs/throttler`,**
because the KEY is the design (`common/rate-limit/rate-limit.ts`). Learners
share corporate NAT addresses, so a per-IP budget on signed-in traffic would
lock out a client at 9am. `RateLimitGuard` runs directly after AuthGuard: a
signed-in request counts per USER (600/min default), a public one per IP
(300/min). Routes declare their own with `@RateLimit(...)`:

| Route | Budget |
|---|---|
| POST /auth/login | 10 / 15 min per IP + email, and 300 / 15 min per IP |
| POST /auth/mfa/verify | 30 / 15 min per IP |
| POST /auth/forgot-password | 20 / hour per IP (the service also caps per account) |
| reset-password check / submit | 60 and 30 / 15 min per IP |
| POST /auth/change-password | 10 / 15 min per user |
| GET /certificates/verify/:code | 30 / min per IP (the §10.23.2 follow-up) |
| GET /my-data/export | 10 / hour per user |
| POST /email/unsubscribe | 1000 / min per IP (mail providers share addresses) |

A 429 carries `Retry-After` and says when to try again. The client IP is
`CF-Connecting-IP`, then the first `X-Forwarded-For` hop, then the socket.
**Counters are in process memory**: correct for today's single API process; a
second instance would double every budget and a restart clears them. Move them
to Postgres or Redis when the API is scaled out. Forged forwarding headers
can dodge a per-IP limit only if the origin is reachable without Cloudflare.

**Security headers are set by hand** (`common/http/security-headers.ts`), not
with `helmet`, whose defaults would break this API: `same-origin` resource
policy would block avatars and attachments loaded by the app origin (they are
same-SITE), and its script CSP would stop SCORM packages tracking. Set:
`nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy:
same-site`, a `Permissions-Policy` denying camera, microphone, location and
payment, HSTS only when the request arrived over HTTPS, and
`Content-Security-Policy: frame-ancestors 'self' <CLIENT_ORIGIN...>`.
**Not `X-Frame-Options`**: a PDF lesson is an iframe of an API URL inside the
app origin, so SAMEORIGIN would blank every PDF lesson. Verified in a browser:
the app origin may frame the API, an unlisted origin is refused.
`X-Powered-By` is removed. The client sets its own equivalents in
`next.config.mjs` (`frame-ancestors 'self'`, no script CSP yet: Next's inline
bootstrap would need nonces).

### 10.48 Retention, completed: anonymise everywhere, time limits, client offboarding

`0067_retention_offboarding.sql`. §10.43's sweep cleared only the `users` row,
so a departed person's name, email and IP stayed in a dozen other tables and
on disk: not anonymised in law, still personal data. This finishes the job.
Same worker cron, same two guards (`RETENTION_ENABLED`, `RETENTION_DRY_RUN`),
three jobs in order:

**1. Client offboarding.** A platform admin schedules it on the tenant
(`PUT /api/platform/organizations/:id/data-deletion { due_at }`, `DELETE` to
cancel, `GET` to read). Refused unless the tenant's access is already OFF,
the date is at least a day away (so it can be cancelled), and the deletion
has not run; never for the platform org. On the date the sweep anonymises
every person in it, active or not, then deletes its direct messages,
community posts (and files), notifications, activity, audit log, email rows
and privacy requests, and stamps `data_deleted_at` so it runs once. Courses
and other content the client authored are not personal data and stay.

**2. A person past the window** (`anonymizeUser`, one transaction per person,
the `users` row LAST so a crash is simply redone with the name still there to
search for). Their own notifications, emails, MFA and reset tokens are
deleted; their name, public "First L." form and email are replaced with the
tombstone inside colleagues' notifications, emails, activity titles, audit
summaries, community posts and replies; their own posts and replies are
blanked and removed; feedback RATINGS stay and free-text comments go; an
external certification keeps its record and loses the name and the scan;
SCORM `cmi_data` loses `student_name`/`student_id`/`learner_name`/`learner_id`;
a privacy request keeps type, status and dates and loses what they wrote.
**Direct messages are KEPT** for an individual (the owner's decision,
2026-11-18); the sender shows as "Deleted User" through the users row. Names
are matched by the full and public forms and the email, never the first name
alone, which would corrupt unrelated words.

**3. Time limits for everybody** (privacy-pack document 03, owner-approved
2026-11-18): audit log, activity feed and SCORM detail log 12 months; READ
notifications 6 months and unread 12; failed emails 180 days; closed privacy
requests 3 years; expired reset tokens 30 days; removed community posts and
replies 30 days; unconverted referrals 12 months; external-certificate scans
12 months after the decision (record kept). Each category's predicate is
written ONCE (`purgeWhere`) so the dry-run count and the delete cannot
disagree, and deletes run in batches of 5,000.

**Files go after the rows commit** (`RetentionFilesService`): avatars,
shared attachments and certificate scans under `UPLOAD_STORAGE_PATH`, each
name re-checked against the UUID shape those stores write. Its own small
service so the worker does not construct the R2 client to unlink three
kinds of file.

**`npm run retention:sweep`** runs it once, now: COUNT ONLY unless
`--apply`, and `--apply` is refused unless `.env` already has both switches
set, so the command can never do more than the nightly job would. Use it to
read production's numbers before switching the job on.

Verified end to end on the local database with a seeded person and a
throwaway tenant: every table and file above checked after the run, a second
run is a no-op, and the other tenant's rows were unchanged. Pinned by
`retention.service.spec.ts`.

**Direct messages have NO time limit, by the owner's decision (2026-11-18)**,
including between two people who both remain: they are kept, and a party who
is anonymised shows as "Deleted User" through the users row. Only a whole
client's offboarding deletes them.

**Switched OFF in production until go-live (owner's decision, 2026-11-18).**
`RETENTION_ENABLED` is deliberately unset on the box. Do not set it, or
`RETENTION_DRY_RUN=false`, without the owner's word; `npm run retention:sweep`
(count-only) is safe to run any time.

**Not covered:** database backups and Gmail's Sent copies (operational,
document 03 section 8); per-organization retention periods (one server-wide
setting).

### 10.49 Two-step sign-in mandatory for admins; nobody sets another person's password

Two owner decisions (2026-11-18), no migration.

**Two-step sign-in: mandatory for admin-portal accounts, optional for everyone
else.** `MfaController` is open to every role (`@AllowBeforeMfa()` at class
level); `POST /auth/mfa/disable` refuses an admin with 403; `status` returns
`required`. The login challenge applies to ANYONE with it enabled, not only
admins. `PublicUser.mfa_setup_required` is true for an admin without it, outside
a support session, when `MFA_ENCRYPTION_KEY` is set.

**The API enforces it, not only the screen.** `MfaEnrolmentGuard` (global,
after AuthGuard and RateLimitGuard, before role and permission guards) refuses
every route for such an admin with 403 "Set up two-step sign-in to continue",
except routes marked `@AllowBeforeMfa()`: `GET /auth/me`, `GET /auth/profile`,
`POST /auth/consent`, `POST /auth/exit-impersonation` and the MFA routes
(public routes such as logout pass anyway). Without the guard, a stolen admin
password could skip the setup page and call the API directly. Not applied to:
non-admins; a support session (the platform admin passed their own second
factor); a server without the key (nobody could enrol; a warning is logged).
A confirmed enrolment is remembered for 60 seconds per process, so admins cost
no extra query per request; the cost is that an enrolment removed by hand in
the database keeps working for up to a minute.

The client holds the admin at `/mfa-setup` (checked in `requireSession`
before the notice), which uses the same `TwoFactorSection` as My Profile.

**Recovery is manual.** An admin who loses both the authenticator and the
recovery codes can only be reset by Edstellar deleting their `user_mfa` row
(identity-verified and logged). A reset feature is a known follow-up.

**`npm run test:isolation` sets up two-step sign-in** for each fixture admin it
signs in as (a real setup and enable, secret generated in the script) and
deletes the enrolment at teardown; an enrolment left by an interrupted run is
cleared and retried.

**Nobody sets another person's password.** `CreateUserDto`, the bulk row and
the platform `CreateOrganizationUserDto` have no password field (a client that
still sends one has it stripped by the whitelist). Every account created by
someone else gets `unknownPassword()` (48 random bytes, hashed, never stored or
shown) and the welcome email's set-password link; the platform path now sends
the welcome too. `DEFAULT_BULK_PASSWORD` (`Edstellar@123`, written in source)
is gone, and so is the bulk template's Password column. A person whose welcome
is lost uses "Forgot password".

**Accounts created before this release** may still hold the old shared default
or a password an admin typed. Checking production for them, and forcing a
reset, is a separate decision.

### 10.50 Operational alerts to Zoho Cliq

`0068_system_heartbeats.sql`. The incident response plan's top gap was that
nothing alerted anyone: an outage or an attack was found only when somebody
noticed. Alerts now post to the team's Cliq channel
(`spectralmsserverlogissues`, as the bot `spectralmsserverlogs`).

**`AlertsService` (`modules/alerts`), three rules:** it never throws or blocks
the caller (fire-and-forget, 5-second timeout, §8.4); it sends NO personal
data (callers pass user and organization numbers; every line is scrubbed of
anything shaped like an email or IP address, because Cliq is another
company's service); and each alert key repeats at most every 15 minutes by
default, per process. If Cliq answers `bot_not_member` it retries once as the
token's owner, so a membership mistake never loses an alert. No token = off.

| Alert | Raised by | Level |
|---|---|---|
| API not responding (and recovered) | worker, `system-watch` job every minute: `GET /api/health` on the local port, 2 failures in a row | critical |
| Worker stopped (and recovered) | API, `ApiWatchService` every minute: the worker's heartbeat row older than 5 minutes (silent until a worker has beaten once, and for 5 minutes after boot) | critical |
| Burst of unexpected server errors | `HttpExceptionFilter`: 5 non-HttpException 5xx in 5 minutes | high |
| Failed sign-ins | `AuthService.login`: 10 for one account, or 30 for unknown addresses, in 15 minutes | high |
| Sign-in rate limit tripped | `RateLimitGuard`, login / MFA / reset rules only | high |
| Security incident logged; a legal clock due within 24 h or overdue | `IncidentsService.create`; worker `incident-clocks` job hourly at :40 (each clock every 12 h) | critical / high |
| Emails failing (e.g. Gmail `invalid_grant`) | `EmailFailureAlertsService`, hourly | high |
| Support session opened | `AuthService.impersonate` | info |
| Retention job result (once enabled) | `RetentionService.sweep` | info |
| Deploy succeeded / FAILED | both repos' GitHub Actions deploy step, via `scripts/cliq-notify.mjs` on the server | info / critical |

The API and the worker each watch the OTHER, because a process cannot report
its own death. `GET /api/health` is public and cheap (one `SELECT 1`; 503 when
the database does not answer), and is also what an external uptime monitor
should watch: a whole-server outage stops both processes, and only an outside
monitor can report that. Burst counters are in process memory, like the rate
limiter's.

Verified: unit tests (`alerts.service.spec.ts`: scrubbing, repeat limit, bot
fallback, thresholds, the API-down/recovery sequence) and live posts from
development (deploy notice, failed-sign-in burst, rate limit, incident logged,
support session).

### 10.51 Two-step sign-in: authenticator app or emailed code

`0069_mfa_methods.sql`. Each person chooses the method; mandatory for admins is
unchanged (§10.49).

**Pending and active are separate columns, and that is the safety.**
`user_mfa.method` / `secret` are the ACTIVE method; `pending_method` /
`pending_secret` are a setup in progress. `setup` writes only the pending pair,
`enable` checks a code for the pending method and only then moves it across
(`activatePending`, one statement) with fresh recovery codes. So switching from
the app to email, or back, never leaves the person unprotected or locked out
part-way: the old method keeps working until the new one is confirmed. Old
recovery codes are replaced on every switch.

**An emailed code is sent IMMEDIATELY, never through the outbox.**
`ImmediateMailService.sendSignInCode` renders a synthetic row and calls the
mailer directly: a sign-in code that waits for the next drain tick (up to a
minute) is a sign-in that fails, and an outbox row would keep the code in a
table. It still honours the address-level gates (suppression list, allowlist,
`EMAIL_ENABLED`) and throws 503 when it cannot send; the login response then
carries `send_error` and the person can use a recovery code. `mfa_code` is in
`UNSUPPRESSABLE` and has no button.

**Codes are stored as HMAC-SHA256 with a server pepper** (`auth.jwtSecret`)
over `userId:purpose:code`, compared timing-safe. A plain hash of a six-digit
code is reversed in a millisecond from a database copy; the pepper stops that.
10 minutes, one use, 5 wrong tries, and issuing a code retires the earlier
ones. At most 5 codes per person per 15 minutes (429), plus the route budgets
below. `purpose` (`enrol` | `login`) keeps a setup code from being spent at
sign-in and vice versa, and gives each email its own wording.

**Which methods exist is decided by configuration, per server.** The app needs
`MFA_ENCRYPTION_KEY`; email needs email switched on. `status` returns
`methods_available`; `canEnrol()` (either works) is what admin enforcement and
`mfa_setup_required` key off, so a server with only email can still hold
admins to it. `isEnabledForLogin` is method-aware: an active email enrolment on
a server whose email is off does not challenge (otherwise nobody could sign
in), and the warning is logged at boot.

Routes added:

```
POST /api/auth/mfa/resend       @Public, challenge token; a new code at sign-in   (10 / 15 min per IP)
POST /api/auth/mfa/email-code   signed in, email method; a code to turn it off    (5 / 15 min per user)
POST /api/auth/mfa/setup        body { method: 'totp' | 'email' } (default totp)
```

The login MFA response gained `mfa_method`, `sent_to` (masked) and
`send_error`. Pinned by `mfa.service.spec.ts`; verified end to end against a
second API instance with the `file` mail driver (enrol by email, wrong and
reused codes refused, sign-in + resend, switch to app with email still active
until confirmed, old recovery codes refused, turn off with an emailed code,
429 on the sixth code, code stored only as a hash).

**The email method is weaker than the app** — it is as safe as the mailbox,
and a mailbox usually also controls password reset. Policy 03 says so and
encourages the app; it is still a large step up from a password alone.

### 10.52 Private uploads were inside the public /uploads mount

Found while preparing the client-facing tenancy statement. `main.ts` mounted
the whole `UPLOAD_STORAGE_PATH` at `/uploads` with no sign-in, for course
thumbnails (§10.10). That root ALSO held the private stores:
`external-certifications/` (certificate scans, §10.26) and `shared/` (community
resources and message attachments, §10.42). Both services' docblocks said they
were outside the published directory; they were not. On dev an unauthenticated
request for a stored scan returned 200.

Practical exposure was limited: the file names are random UUIDs and are never
sent to a browser (`file_path` is not selected into any response), so a file
could not be found without already holding its name. It was still wrong, and a
statement to clients could not claim the protection.

**Now only `ImageStorageService.PUBLIC_DIRS` (`course-thumbnails`, `avatars`)
are mounted**, each at `/uploads/<dir>`. Organization logos are stored with the
thumbnails. Everything else under the uploads root is reachable only through
its access-checked route. Adding a new public image folder means adding it to
`PUBLIC_DIRS`; adding a private store needs nothing, which is the safe default.

`npm run test:isolation` section 10 writes a canary file into each private
folder and requires a 404 without sign-in, and requires a thumbnail canary to
stay 200. Verified on dev: scan 404 (direct and through the web app's rewrite),
thumbnail and avatar 200, `/uploads/` 404, a `../` traversal 404, and the
checked route still 401 without a session.

### 10.57 Bugs found by the e2e suites, fixed (2026-11-21)

The API e2e suite (`server/test`) and browser journeys (`client/e2e`) were
written against CONTEXT.md and found 19 real defects; each now has a passing
test. Server-side: cross-org deletes of courses, sessions and assessments
answered 200 instead of 404 (`remove()` never checked the row existed);
bulk session delete counted unknown ids; course skill tags used
`ParseIntPipe` (so the Course page's UUID failed) and had no org check;
fill-in-the-blank and matching could not be answered or scored and the
learner read carried `correct_answer`; multi-select compared one option with
MAX(correct id); deleting a module or lesson left `link_type` pointing at it
(now set to 'none' in the same transaction); `completeLesson` skipped the
sequential lock §10.25 recorded; an archived course could be assigned; bulk
assign counted conflict-updated rows (now `xmax = 0`); Webinar certificates
were printed as in person; the AI context sent `organizationId` (now dropped
by `forModel()`, still asserted by `assertSameTenant`); session feedback
answered 201; `me()` ignored a support session for `consent_required`; the
learner engagement trend took its axis from learning rows only.

### 10.53 Competencies — the AI Insights foundation

`0070_competencies.sql`. The first slice of the AI Insights program
(`specs/ai-insights.md`): the data that lets later waves ground recommendations
in what a learner actually knows. **No AI and no PII in this slice** — pure data.

Three tables. `skills` and `course_skills` are CONTENT (`contentScope`): the
platform organization owns a seeded starter catalogue every tenant sees, and a
tenant may add its own skills, private to it. `user_skills` is ACTIVITY
(`orgScope`): a competency a learner gained always belongs to their own org, so
a shared skill never shows one tenant another tenant's learner counts (§10.12).

**Recording reuses the ONE completion definition.** `CompetenciesService.onCourseCompleted`
is called best-effort at the three completion seams (scorm, assessments, learner)
beside `autoIssue` and `onCourseProgress`. Those seams fire on every
lesson-complete/assessment-submit, not only on the last, so it re-derives
completion through `CertificatesService.isCourseComplete` (a thin public wrapper
over `getCompletionSnapshot` + `evaluate`, added here) rather than writing a
second definition that could drift (§10.11). On genuine completion it upserts
`user_skills` from the course's `course_skills` — one statement, idempotent (a
replay only refreshes `source_course_id` / `last_reinforced_at`), and `level` is
**UPGRADED** by rank (beginner<intermediate<advanced), never downgraded, so a
later advanced course lifts a skill a beginner one first granted. `GREATEST` over
the text labels would order them alphabetically, so the rank is a CASE.

**No new permission.** Skill curation and course mapping are guarded by
`manage_courses` — which skills a course imparts is a property of the course — so
no grant migration and no `perm_version` bump (§10.24's reasoning). A learner's
own-competency read carries no permission and takes no id (the subject is the
caller).

```
GET   /api/admin/skills[?archived=]          list (own + platform), counts   (manage_courses)
POST  /api/admin/skills                       create (409 on duplicate slug)  (manage_courses)
PATCH /api/admin/skills/:id                   rename / archive (own only)     (manage_courses)
GET   /api/admin/skills/course/:courseId      a course's mapping              (manage_courses)
PUT   /api/admin/skills/course/:courseId      replace a course's mapping      (manage_courses)
GET   /api/learner/competencies               the caller's own gained skills  (learner)
```

**Known follow-up:** the course→skill mapping has no authoring-screen UI yet
(it is API-only this slice), and the learner competency panel ships with the
learner vertical (Wave 2).

Superseded (2026-11-20): both shipped. The mapping is the course page's
**Skills** tab (`client/components/admin/course-skills-tab.jsx`), and a
learner's gained skills are drawn on the AI Insights page from
`GET /api/learner/ai/charts` (§10.54).

### 10.54 AI foundation — the OpenRouter client and insight store

`0071_ai_insights.sql` + `modules/ai` (spec ai-insights.md Wave 1). The shared
engine the learner (Wave 2) and admin (Wave 3) verticals plug into. It has no
controllers — a surface that triggers generation belongs to the vertical that
defines what is generated.

**OFF by default, warn-and-degrade, exactly like email/R2.** `AiClientService`
makes no call and returns null unless `AI_ENABLED=true` AND an
`OPENROUTER_API_KEY` is set, so an un-enabled deployment spends nothing and sends
nothing out. Enabling it is a deliberate, cost-bearing act — and the data that
would leave the box (the feature layer's prompt, Wave 2) is a human checkpoint
reviewed as a PII surface before that switch is flipped.

**Never throws.** A model timeout, HTTP error or unparseable content returns null
(§8.4) — a recommendation is best-effort and must never 500 a request or a cron
tick. `completeJson` also recovers JSON a model wrapped in prose or a code fence.

**No SDK**, one HTTPS POST to `/chat/completions`, the same reasoning as SESv2 and
the Gmail API. Model attribution headers carry the product origin and name only,
never anything learner-identifying.

**The default model reasons.** `deepseek/deepseek-v4-pro` emits reasoning tokens
before its answer, and they count toward `max_tokens` — a small cap is spent
entirely on thinking and returns empty content (observed: `max_tokens: 10` gave
zero content; `800` returned clean JSON). Hence `AI_MAX_OUTPUT_TOKENS` defaults to
3000 and the timeout to 45s. Verified live: key valid, model resolves, structured
JSON returned, cost ~$0.00002 for the probe.

`ai_insights` stores one latest insight per (org, subject, kind), upserted by a
refresh and read by the UI. ACTIVITY (`orgScope`). The payload is the model's
structured output and holds **no raw PII** — the feature layer sends only
aggregates and ids, so what comes back is advice, not personal data.

The verticals live in `modules/ai-insights`:

- **Learner (Wave 2)** — `LearnerInsightsService` builds a PII-light context by
  REUSING `LearnerService.courses`, `LeaderboardService`, `BadgesService`,
  `CompetenciesService` and `SurveysService` (no second definition of
  completion/points), plus one new query for recommendable courses + job
  attributes. `GET /api/learner/ai/insights` (renders nothing when off) and
  `POST .../refresh` (RateLimit 5/hr/user). Stored as subject `learner`, kind
  `recommendations`. `GET /api/learner/ai/charts` is a separate, AI-independent
  read: `buildCharts` reshapes the SAME canonical services (competencies, My
  Courses, leaderboard, badges) into a real-data chart bundle (skill radar,
  competency levels, skills-by-domain, course-status, category progress, badges,
  points, totals) the page draws many chart types from, shown whether or not the
  model is enabled — no model tokens, no re-derived number.
- **Admin (Wave 3)** — `AdminInsightsService` reuses `AnalyticsService.dashboard`
  (the one org aggregate: completion, dept roll-up, overdue, deterministic
  signal sentences) plus two negative-feedback aggregates (low-rated courses via
  the §10.24 overall-rating definition; low-rated sessions via the structured
  `session_feedback` columns, both min 3 responses). The feedback reads send
  RATINGS and COUNTS only, never the free-text comments. `GET /api/admin/ai/insights`
  + `POST .../refresh`, both `view_reports` (no new permission). Stored as subject
  `org`, kind `org_overview`.

Each context builder is the PII surface for its vertical: opaque ids, content
titles, department names and aggregates only, reviewed before enabling.

**The model EXPLAINS, in a structured form (owner request 2026-11-19).** Both
the learner coach and the admin briefing payloads lead with a `sections` array —
each a heading, a one/two-sentence description and ordered points, with the
words that matter wrapped in `**bold**`. The format is defined once in
`ai-narrative.ts` (`NARRATIVE_SECTIONS_SCHEMA` + `NARRATIVE_SECTIONS_INSTRUCTIONS`)
so both prompts ask for the same shape and one client renderer
(`components/shared/ai-sections.jsx`) draws both. The lens prompts
(course_recommendations, skill_plan) also mark key terms in their prose with
`**`. Older cached insights predate `sections`; the UI simply shows the
structured cards beneath when it is absent.

#### Tenant isolation is enforced, not assumed (`ai/ai-tenant.ts`)

The model provider is stateless about our tenants, so isolation lives in OUR
code, before and after every call — the industry rule for multi-tenant AI. The
data flow is already single-tenant by construction (one request = one JWT = one
`OrgScope`; every context query takes that scope; one prompt only ever carries
one learner/org; `ai_insights` is `orgScope` on read and write; no cache, and no
cross-tenant batching anywhere). What `ai-tenant.ts` adds is that this is
ENFORCED and proven rather than relying on every future query remembering to
scope:

- **One chokepoint.** Every vertical generates through
  `AiInsightsService.generateForTenant(scope, params)`, never the client
  directly. It is the one method that reaches the model, and it requires a scope.
- **A context carries the org it was built for, and it is ASSERTED.** Each
  feature context has `organizationId = scope.organizationId`;
  `assertSameTenant(scope, context.organizationId)` runs before the call. A query
  that forgot to scope — the only way one tenant's row could reach another's
  prompt — fails loudly here instead of leaking. It also makes a blended
  cross-tenant context (the trap the deferred cron must avoid) impossible: that
  cron must be N isolated calls, one scope each, never one combined context.
- **The system prompt is fenced.** `TENANT_ISOLATION_DIRECTIVE` is prepended to
  every system prompt: use only the provided context, never reference or infer
  another organization/person, and treat data as data (prompt-injection defence
  on top of the existing `clip()` of user strings).
- **No tenant identifier leaves the box.** Only product origin + title go to the
  provider; the org id stays internal (logs/assert), so even provider-side there
  is nothing to mix. Zero-retention / no-train is an operational control on the
  OpenRouter account (a DPA), not something code can assert.
- Proven by `ai-tenant.spec.ts` (the fence throws on a foreign org) and the
  vertical specs (generation is called with the context's org matching the scope).

Still to build: the nightly worker cron that pre-generates insights (deferred —
must mint one scope per org and call `generateForTenant` per tenant, never a
combined context; plus cost caps in the worker; on-demand refresh proves the
pipeline), AI bell/push notifications for milestones, and a period-over-period
trend signal in the admin context (InsightsService series, a 3.1 enhancement).

### 10.55 Engagement hours, and the comparison with learning hours

`0072_engagement.sql` + `modules/engagement` (owner request 2026-11-19). A NEW
metric beside §10.4 learning hours, which are **unchanged**.

**The two measure different things on purpose.** Engagement is ACTIVE time on
the platform; learning hours is completion-credited time (§10.4). A learner can
be engaged (browsing, clicking) without producing learning hours, and the
comparison surfaces exactly that gap.

**Engagement = active time, idle over 5 minutes excluded.** The client hook
(`use-engagement-tracker.js`, mounted once per authenticated layout) accrues
active seconds in 15s ticks only while the cursor/keyboard has moved within the
last 5 minutes AND the tab is visible, and flushes a batch to
`POST /api/engagement/ping` about once a minute and on `pagehide`. It is
best-effort telemetry: it swallows its own errors and never blocks the UI, like
the SCORM data-model recorder (§10.9).

**`engagement_daily` is one accumulator per (user, day)**, ACTIVITY so `orgScope`
on every read. The ping upserts, adding seconds capped at a day (`LEAST(..,
86400)`); the DTO also caps a single ping at 600 seconds, so neither a broken nor
a hostile client can inflate the figure. Both `LEAST` arguments are cast `::int`
— a bare parameterised number resolves to `text` and clashes with the integer
column.

**The comparison REUSES the learning-hours definition.** `EngagementService`
builds the learning series from `LearningHoursService.learnerHoursTrend` (learner)
or `minutesByPeriod` (org) and overlays engagement onto the SAME period buckets,
so the chart can never disagree with the Learning Hours page. Learner and admin
each get a trend at four granularities (weekly/monthly/quarterly/yearly) with
per-period `learningHours` + `engagementHours` and totals.

**Engagement is drawn as the SUPERSET of learning, per period
(`engagementFloor`).** The owner's model is that a learner's learning time is
PART of the time they spent in the app — a 45-min lesson sits inside the hour
they were logged in, so the UI shows 1h engaged with 45m of it learning. But the
two are measured differently: engagement is tracked active time, while learning
is §10.4 completion-credited (the lesson's full DECLARED duration, credited
whole however fast it was finished — §10.4). So a period can credit more learning
than raw active time caught, which would make the stacked chart contradict itself
(a 45-min learning segment inside a shorter "engaged" total). Completing 45 min
of learning means the learner was present at least that long, so the displayed
engagement is `max(tracked, learning)` per period. The floor only raises
engagement to meet learning when tracking under-caught; it never touches the
learning number. The client's stacked bar then splits engaged time into learning
+ other-active, with `other = engagement − learning ≥ 0` always.

```
POST /api/engagement/ping             any authenticated role; { seconds } (1..600)
GET  /api/learner/engagement/trend    the caller's own          (?granularity=)
GET  /api/admin/engagement/trend      the org's                 (view_reports)
```

The dashboards render it as `components/shared/engagement-vs-learning.jsx`
(a STACKED bar per period — learning + other-active = total engaged — a
granularity toggle, totals, and a "X% of engaged time went to learning" line).
Stacked rather than side-by-side because learning is a SHARE of engagement, not a
rival series; two bars read as a contradiction when engagement is always the
larger. Verified live: ping → stored → the trend reflects it, the 600s cap
refuses an oversized batch, and the learning series matches §10.4.

**Known follow-up:** the final `pagehide` flush uses the normal client rather
than a keepalive beacon, so the last partial minute can be lost on a hard close
— acceptable for a best-effort engagement figure.

### 10.56 Learning Intelligence (risk radar, effectiveness, skill intelligence)

`GET /api/admin/ai/intelligence` (`view_reports`), in `admin-intelligence.repository.ts`
+ `AdminInsightsService.intelligence`. The Phase-1/2 analytics the AI briefing
narrates, as REAL numbers (§10.54's accuracy rule — the model explains, it never
invents these). All tenant-scoped (content `contentScope`, activity `orgScope`).

- **Inactivity**: active learner-portal users with no lesson completion or
  assessment attempt in 30 days, over the total.
- **Course effectiveness**: per enrolled course, a content-completion rate
  (`lesson_completions / (enrolled × active lessons)` — labelled as content
  consumed, NOT the §10.11 all-lessons-done definition, which is unchanged),
  avg passing score, whether it has an assessment, and flags (no assessment /
  low completion / low scores).
- **Risk radar**: five 0-100 severity dimensions (overdue load, inactivity, low
  completion, assessment risk, course quality) reusing `AnalyticsService.dashboard`
  for completion/overdue/pass-rate, plus an overall score.
- **Organisational skill intelligence**: competency coverage per skill domain
  from `user_skills` (distinct learners, avg level). Empty until courses are
  skill-tagged — the UI says so and points at the course Skills tab.
- **Department benchmarks**: `deptCompletion` with the k-anonymity floor (§10.54).

These signals are also folded into the AI briefing CONTEXT (`intelligence` block),
so the briefing's risks/recommendations reference inactivity, flagged courses and
weak skill domains. The admin AI Insights page renders them as real-data sections
(`components/admin/admin-intelligence.jsx`) that show regardless of whether AI
generation is enabled.

`intelligence()` also returns (owner request 2026-11-19, for more charts on that
page) `healthScore` (the same 4-axis composite the briefing uses), `headline`,
`engagement` and `statusBreakdown` — all read from the one `analytics.dashboard`
call it already makes, so no new query and no figure that can disagree with the
Analytics page. The page draws them as a KPI strip, a health gauge+radar, a
course-status donut, completion/pass gauges and a course-effectiveness scatter,
beside the existing risk radar, skill bars, department bar and tables. Verified live against org 7: risk radar, inactivity 9/9,
effectiveness and the (empty, honest) skill section all returned.

**Still deferred:** completion/assessment time-series in the module (they live on
the Analytics page; the AI page links there), per-learner risk prediction as a
dedicated learner-facing view, and the nightly pre-generation cron.

### 10.59 Community reactions, responses, and admins taking part (0073, 2026-11-23)

**A reaction is a KIND on the existing row, not a second table.**
`community_reactions` gained `kind` (like, helpful, insightful, thanks,
great_explanation, agree; CHECK-constrained, catalogue in
`common/community-reactions.ts`). The `(post_id, user_id)` unique index already
existed, so "no duplicate reactions" is enforced by Postgres: `PUT
:postId/reaction` is an `ON CONFLICT ... DO UPDATE SET kind`, and changing kind
moves the person's one count rather than adding one. Every pre-0073 row was a
heart, so the column default backfills them as `like`, and the old `like`
routes are now `react(..., 'like')` with unchanged response shapes.

**`like_count` means the TOTAL across kinds**, recounted in the same
transaction as the write (one CTE that groups by kind, updates the counter and
returns the breakdown). The per-kind breakdown on the feed is a correlated
`json_object_agg` per card riding the unique index, so the feed still costs one
round trip.

**Responses are one level deep.** `community_replies.parent_reply_id` (ON
DELETE CASCADE, partial index). The service resolves a response-to-a-response
to its top-level parent, so threads never become staircases, and refuses a
parent from another Post (or org) with 404. The parent's author is notified in
addition to the Post's author, never twice and never the replier.

**Taking part carries no Permission; moderating does.** An Admin replies and
reacts through `POST admin/community/:postId/replies` and `PUT/DELETE
admin/community/:postId/reaction`, open to the whole admin audience exactly as
the learner routes are open to every learner (participation is not a granted
capability). Deleting OTHER people's content stays `moderate_community`. Both
participation paths go through the same service methods as the learner's, so
the community switch (`assertEnabled`) and org scoping apply identically.

**Who reacted: two views of one query.** `postReactors` returns the author
columns plus department and kind. The learner route shapes first name + last
initial (§10.24); `GET admin/community/:postId/reactions` returns full name,
email, department, portal and time, the same disclosure the admin feed already
makes for authors. `author_portal` is read on every author row so the UI can
mark an Admin as "L&D".

Pinned by `community.service.spec.ts` and the "quick reactions, responses to
answers, admin participation" block of `test/community.e2e-spec.ts`.

### 10.60 Two-step sign-in exemption for named accounts (2026-11-24)

The owner asked for one shared demo admin to sign in without the second
factor, while every other admin keeps it. `MFA_EXEMPT_EMAILS` (comma list,
case-insensitive) is read once at boot into `MfaService.isExempt()`, and an
exempt address is honoured in exactly three places: `login` (no challenge even
with a method enrolled), `mfaSetupRequired` (never sent to `/mfa-setup`) and
`MfaEnrolmentGuard`. Nothing else changes for that account: its profile still
says two-step is required and cannot be turned off.

**Why configuration, not a database flag.** It is a deliberate weakening of
one control, so it should live where the operator can see it, need a shell to
change, and leave no trace in the product's own screens that an admin could
toggle for themselves. Removing the address and restarting restores the
challenge with no deploy. The boot logs how many accounts are exempt, and every
exempt sign-in logs a warning with the user id, so it is never silent.

Pinned by `test/auth.e2e-spec.ts` (an enrolled exempt admin signs in on the
password and reaches an admin route; an enrolled non-exempt admin is still
challenged).

### 10.61 Course recommendations are fenced by job role (2026-11-24)

"Courses chosen for you" sent the model the 20 newest unassigned courses and
the learner's job role, and trusted it to choose sensibly. It did not always:
nothing stopped a sales course reaching a software engineer. The fix is
deterministic, in `common/job-role-fit.ts`:

- the learner's free-text Job role is read into one of eight job functions by
  keyword (business words before craft words);
- each course is read into the functions it is built for from its name, tags,
  skills and category, with Compliance and "for managers"-style titles for
  everyone;
- `rankForRole` drops courses built only for other functions and orders the
  rest role, related, general. The pool read is widened to 80 so filtering
  still leaves enough, and 20 are sent.

The model is told what `roleFit` means, but is not trusted with it: both the
coach's `recommendedCourses` and the lens's `recommendations` are filtered
again after generation (`keepAllowed`), dropping anything not in the list.
The lens payload also stores the role it matched, so the panel can say so.
Department is still never read (§10.54's PII rule): the job role alone decides.

Pinned by `job-role-fit.spec.ts` (the demo org's real roles and catalogue),
`learner-insights.service.spec.ts` and `client/e2e/ai-insights.spec.mjs`, where
the fake model echoes names from the list it is sent so the filter is real.

### 10.62 Skills reach people where they look, and late tags still count (2026-11-24)

Three gaps made gained skills invisible in production. A course was created with
free-text Tags and no Skill tags (so completion granted nothing), the learner
course page labelled those Tags "Skills you'll gain", and no screen listed a
learner's own skills; `GET learner/competencies` had no caller.

- **Late tags still count.** `setCourseSkills` now calls `awardToCompleters`:
  SQL narrows to active, assigned people with at least one lesson done, then each
  is checked with the ONE completion definition (`isCourseComplete`) before
  `recordCourseSkills`. A per-person loop, deliberately: it is bounded by one
  course's assignments, runs only when an admin saves, and keeps a single
  definition of "complete". The response gains `awarded`.
- **Learner course detail** carries `skills` (the course's Skill tags, each
  `earned` when held at that level or above). Tags are shown as Topics.
- **`GET admin/skills/analytics`** (`view_reports`, like the other insight
  reads): coverage per skill split by level, holders (names, for the
  drill-down), a 12-month trend (awards, people gaining, people holding at the
  month end), awards per area per month, department coverage and untagged live
  courses. Every holder count carries its own `orgScope` inside the content row
  (§10.12) and excludes deactivated people. One `Promise.all` of fixed reads.

Pinned by `competencies.service.spec.ts`, `test/competencies.e2e-spec.ts` and
`client/e2e/admin-course-skills.spec.mjs`.

### 10.63 Batch scheduling: one derived sitting shape, per-batch seats, session report (0074, 2026-11-24)

**Model.** `session_batches.end_date` and `sessions.end_date` (NULL = one day)
let a batch, or a batch-less session, span days; times stay daily.
`session_waitlist.batch_id` gives each batch its own queue (ON DELETE SET
NULL falls back to the session queue). Nothing is duplicated: one session row,
one roster row per person (at most one batch), one attendance row per person.

**One derivation.** `common/session-schedule.ts buildSittings` turns a session
and its batches into sittings (dates, daily times, capacity with the session's
as fallback, registered, available, waitlist, status, total minutes).
`SessionsService.sittingsFor` reads batches and waitlist counts for a set of
rows in two queries and attaches it to the admin list, learner list, trainer
list and catalogue; the report uses it too. A view never recomputes seats.

**No overbooking.** Every path that puts someone in a batch (self-booking,
admin add with `batch_id`, move between batches, waitlist promotion) runs its
count-then-write inside `withSeatLock`, a transaction holding
`pg_advisory_xact_lock(7401, sessionId)`, so concurrent bookings on one
session serialise. A full batch: a learner queues for that batch; an admin gets
a 409 naming the batch and its count. Lowering a batch's capacity below its
people is a 409. A session with batches must be booked with `batch_id` (422).
Seats are never stored, so a cancellation frees one at once. Promotion stays
manual (Waitlist promotion), now into the queued batch.

**Learning hours.** The companion lesson's duration is the daily length times
the session's days. A batched session still credits the session's own length
(one companion lesson); per-batch lengths are reported, not credited.

**Admin reads.** `GET admin/sessions/:id/feedback` (names, batch, ratings,
comment, date, averages), `GET :id/report` (JSON, which the client prints as
the PDF) and `GET :id/report.xlsx` (four sheets from the same payload, built by
`session-report.xlsx.ts`). Open to the admin audience like the roster and
attendance reads beside them.

Pinned by `session-schedule.spec.ts`, the "batch scheduling, capacity and
reports" block of `test/sessions.e2e-spec.ts`, and
`client/e2e/admin-session-report.spec.mjs`.

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
