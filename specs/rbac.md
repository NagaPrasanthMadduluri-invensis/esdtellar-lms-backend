# Spec: RBAC (per-organization roles and permissions)

> Phase 3 of the three-phase programme begun in `specs/multi-tenancy.md`
> (tenancy → RLS → RBAC). Tenancy phases 1–7 are built and committed; RLS
> (phase 2) is **not** a prerequisite for this work and remains deferred.
> Schema changes in §3 are a **human checkpoint** — nothing there auto-merges.
>
> This spec consumes the seam the tenancy spec deliberately left (§9,
> "Phase 3 (RBAC) seam"): `role` stays the portal selector, granular
> permissions arrive as a `permissions[]` JWT claim.

---

## 1. Goal

Let each organization define its **own roles** and decide what each one can do,
instead of every user being either `admin` or `learner`. An organization that
wants a *Manager* who watches their department's learning, or a *Trainer* who
runs sessions but cannot touch users, configures that itself — without a code
change and without any other organization's roles changing.

A role answers two separate questions, and keeping them separate is what makes
this cheap:

1. **Which portal do I land in?** — unchanged: admin or learner.
2. **What can I do once I am there?** — new: a set of permissions.

---

## 2. Scope

**In scope**
- `roles` and `role_permissions` tables, scoped per organization.
- `users.role_id`, bound to the actor's own org by composite FK (§3.4).
- A **code-defined permission catalogue** (`common/permissions.ts`) plus a
  read-only endpoint so the UI can render it.
- `permissions[]` and `permVersion` JWT claims; `@Permissions()` decorator and
  `PermissionsGuard`; forced re-login when permissions change (§3.6).
- **Department-scoped visibility** — `roles.scope` of `org | department | self`,
  resolved server-side from the actor's own row.
- Wiring `/admin/roles` to real data. It is a **mock today** (§8.1).
- Making learner **Team Learning** real and permission-gated. It is a **mock
  today** and is visible to every learner (§8.1).
- Per-organization role seeding when an organization is created.
- Lockout guards, and an extension to `npm run test:isolation`.

**Out of scope**
- **Row-Level Security.** Still phase 2 of the tenancy programme. Unrelated to
  this work and not a dependency in either direction.
- **Cross-organization roles.** A role belongs to exactly one organization. The
  platform admin is unchanged and is *not* a role — it stays derived
  (`role === 'admin' && organizationId === platformOrgId`), per tenancy §4.2.
- **Field-level permissions.** Permissions gate endpoints and row scope, not
  individual columns.
- **A `departments` table.** Scope keys off the existing free-text
  `users.department`. This is a deliberate, documented compromise — see §8.2.
- **SSO / SCIM group-to-role mapping.** No identity provider is integrated.
- **A portal per role.** Portals stay a closed, small set — `admin`,
  `learner`, `trainer` (§3.1 decision 6). A role does not get a portal because
  it is new; it gets one only when its work has no home in an existing portal.
  A manager explicitly does NOT (decision 2).

---

## 3. Data model

### 3.1 Decisions locked with the product owner

| # | Decision | Consequence |
|---|---|---|
| 1 | **Roles are not a fixed list.** Admin, learner, manager, and an org may want trainer or anything else. | Roles are rows, per organization — not an enum widening. §3.3 |
| 2 | **A manager gets no separate portal.** They use the learner portal with one extra module, "Team Learnings", showing their team. | `role` survives as the portal selector; the module is a permission. §3.5 |
| 3 | **Permissions are configured per organization.** Acme's "Manager" may differ from Invensis's. | `role_permissions` is org-scoped through `roles`; no global defaults table. |
| 4 | **A manager sees only their own department's employees.** | Permissions carry a **row scope**, not just an action. §3.5 |
| 5 | **A permission change forces a re-login.** | Server-side token invalidation via `organizations.perm_version`. §3.6 |
| 6 | **A trainer DOES get a separate portal** — and is not an admin. | Portals become three: `admin`, `learner`, `trainer`. Revises the "two portals" line this spec originally carried; see §3.1.1. |
| 7 | **A trainer may NOT mark a session completed.** | Completion credits every attendee with the training, its hours and its completion, so it stays with an org admin. |
| 8 | **A trainer may NOT change his session's roster.** | Adding a participant creates a course assignment, so roster edits stay with an org admin. The trainer reads the roster and writes attendance. |

### 3.1.1 Why a third portal, when a manager gets none

The two decisions look inconsistent and are not. The test is **whether the
role's work has a home in an existing portal**:

- A manager's work *is* learner-shaped — their own learning, plus a view of
  their team's. It belongs beside "My Courses", so it is one extra module in
  the learner portal and `users.role` stays `learner`.
- A trainer's work is neither. He runs sessions: rosters, attendance,
  participants. Putting that in the learner portal would mix "my learning"
  with "other people's attendance"; putting it in the admin portal would make
  him an admin, which decision 6 explicitly rejects, and would leave every
  un-gated admin screen one missed guard away from him.

The precedent already exists: `client/app/(platform)/` is a third route group
with its own shell and sidebar. `users.role` therefore widens to three values.
It stays plain `TEXT` in Postgres with no CHECK constraint, so this costs no
column migration — only the Drizzle enum, the `UserRole` type, and the portal
routing. **The 22 `@Roles()` decorators stay untouched**: a trainer matches
none of them, which is exactly the intent of "he is not an admin".

### 3.2 The split that makes this safe: code defines capability, data assigns it

A permission string means something **only because a guard checks it**. So:

- The **catalogue** of permissions lives in TypeScript, `common/permissions.ts`,
  as a frozen `as const` object. Adding a permission is a code change, reviewed
  alongside the guard that enforces it.
- The **assignment** of permissions to roles lives in the database and is edited
  by org admins at runtime.

This ordering is the whole point. The current `/admin/roles` mock lets an admin
tick twelve checkboxes that enforce nothing — if the catalogue were also data,
that failure would survive this rewrite: someone could create `delete_everything`
in the UI and it would sit there meaning nothing. A permission that no guard
reads must be impossible to create.

The initial catalogue is the mock's twelve, kept verbatim so the existing UI
copy stays true, plus the two this spec needs:

```ts
export const PERMISSIONS = {
  view_dashboard:      'View dashboard',
  view_employees:      'View employees',
  edit_employees:      'Edit employees',
  upload_content:      'Upload content',
  build_assessments:   'Build assessments',
  assign_learning:     'Assign learning',
  manage_users:        'Manage users',
  view_reports:        'View reports',
  manage_courses:      'Manage courses',
  manage_assessments:  'Manage assessments',
  manage_departments:  'Manage departments',
  view_certificates:   'View certificates',
  // new
  manage_roles:        'Manage roles and permissions',
  view_team_learning:  'View team learning',
} as const;
```

### 3.2.1 Every permission has a guard behind it

The catalogue is only worth anything if each entry is checked somewhere. When
the roles screens went live it was not: **14 of the 19 entries were enforced by
no guard at all.** Only `manage_roles`, `manage_users` (on role assignment
alone), `view_team_learning` and the trainer's three were real. So an
organization could untick "Manage users" and that role could still create
users, or tick "Manage courses" and gain nothing — the mock's defect one layer
down, and harder to spot because the screen was now writing real rows.

Every route is gated now, on one rule:

> **A permission named `view_*` gates a read. Everything else gates writes.**

Content reads stay open to any admin-portal role, deliberately. An
`assign_learning` role has to be able to list courses to assign one, and a
`view_reports` role has to load the course names its report mentions; gating
those reads behind `manage_courses` would break both while protecting nothing
an admin-portal role cannot already see through a report. The four `view_*`
entries — dashboard, employees, reports, certificates — are the reads that
carry something worth withholding, and they are gated.

Three consequences, recorded because they are visible:

- `manage_departments` is **gone**. There is no departments table and no
  department endpoint (§8.2), so nothing could enforce it. Setting a person's
  department is `edit_employees`.
- `manage_certificates` and `manage_sessions` are **new**. Issuing a
  certificate and creating a session had no permission at all, so a role that
  could merely read certificates could also revoke them.
- Migration `0014` grants the two new keys to every existing `is_system`
  `admin` role and bumps that organization's `perm_version` in the same
  statement, so existing admins keep both capabilities and pick them up on
  their next sign-in rather than 403-ing for a week on a stale token.

The admin sidebar carries the matching permission per item
(`client/lib/nav-config.js`), so a restricted role is not offered eleven links
that answer 403. That is navigation, not enforcement — the API refuses
regardless.

---

### 3.3 New tables

```sql
CREATE TABLE IF NOT EXISTS roles (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  key             text    NOT NULL,              -- 'admin' | 'manager' | 'trainer' | ...
  label           text    NOT NULL,              -- what the org calls it
  -- Which portal a holder lands in. The ONLY two values, per decision 2.
  portal          text    NOT NULL CHECK (portal IN ('admin', 'learner', 'trainer')),
  -- Row scope for every list this role can read (§3.5).
  scope           text    NOT NULL DEFAULT 'self'
                          CHECK (scope IN ('org', 'department', 'self')),
  -- A system role is seeded with the organization and cannot be deleted.
  is_system       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    integer NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission text    NOT NULL,                   -- a key of PERMISSIONS, validated in the service
  PRIMARY KEY (role_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_roles_org ON roles (organization_id);
```

`role_permissions.permission` is deliberately **not** an FK to a permissions
table — there is no such table (§3.2). The service rejects any key absent from
`PERMISSIONS` with a 422, and a permission removed from the catalogue in code
leaves harmless orphan rows that no guard reads.

### 3.4 Changes to existing tables

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id integer;

-- Reuse the tenancy guarantee (multi-tenancy.md §3.5): a composite FK makes
-- assigning a role from ANOTHER organization a database error, not a review
-- comment. `roles` already has UNIQUE (organization_id, key); it needs the
-- id-shaped target too.
ALTER TABLE roles
  ADD CONSTRAINT roles_org_id_key UNIQUE (organization_id, id);

ALTER TABLE users
  ADD CONSTRAINT users_role_same_org
  FOREIGN KEY (organization_id, role_id) REFERENCES roles (organization_id, id);

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS perm_version integer NOT NULL DEFAULT 1;
```

**`users.role` does not change, and does not go away.** It stays the two-value
`admin | learner` text column, and it stays the portal selector. That single
decision is what keeps this phase small:

- all **22 `@Roles()` decorators** (17 admin, 5 learner) keep working untouched;
- `RolesGuard` is unchanged;
- the four client route-group layouts and `app/page.js`, which branch on
  `user.role` and `user.isPlatformAdmin`, are unchanged;
- `is_platform_admin` stays derived and needs no role of its own.

`users.role` becomes **derived from `roles.portal`** and written in the same
statement whenever a user's role changes. It is a denormalised copy, kept in
step by exactly one service method, because the alternative — a join on every
token mint and every layout render — buys nothing.

**`role_id` ends up NOT NULL, and that obliges every INSERT into `users`.**
`migrate-rbac.mjs` backfills the column and then sets it `NOT NULL`, which is
what makes the composite FK above a total guarantee rather than one that any
row with a null could sidestep. The cost is easy to miss and was in fact
missed: the two code paths that create a user — `UsersRepository.createLearner`
(an org admin adding an employee) and the platform's organization onboarding —
both wrote `role` and no `role_id`, so from the moment the constraint landed
each returned a 500 from a not-null violation. Both are fixed by resolving the
target role FIRST and inserting the pair together, which cannot desync because
`role` is read off the same role row that supplied `role_id`. The
"exactly one service method" rule in §8.3 is about a second **update** path;
an insert has to name both or the row cannot exist.

> A manager is therefore `users.role = 'learner'`, `roles.portal = 'learner'`,
> `roles.scope = 'department'`, holding `view_team_learning`. Decision 2, with
> no new portal and no new route group.

### 3.5 Row scope — the part that is not just a guard

Decision 4 ("only their department's employees") is the expensive half of this
spec, because it reaches into queries rather than decorators.

`roles.scope` has three values:

| Scope | A list endpoint returns | Typical holder |
|---|---|---|
| `org` | every row in the actor's organization | Admin |
| `department` | rows where `users.department` equals the **actor's own** department | Manager, Trainer |
| `self` | only the actor's own rows | Learner |

It is resolved **server-side from the actor's own `users` row**, never from a
request parameter — the same rule `organizationId` follows, and for the same
reason: a scope a client can name is a scope a client can widen.

The existing `OrgScope` (a branded type that is a required repository parameter,
so omitting it is a compile error) gains a sibling:

```ts
export interface ActorScope {
  readonly organizationId: number;
  readonly platformOrganizationId: number;
  readonly userId: number;
  readonly scope: 'org' | 'department' | 'self';
  /** The actor's own department. NULL is possible and means "matches nobody". */
  readonly department: string | null;
  readonly [brand]: true;   // same unique-symbol brand style as OrgScope
}
```

Minted by `TenantContextGuard` alongside `orgScope`, from the verified JWT plus
the role's scope. `department: null` deliberately matches **no rows** rather
than all of them: a manager with no department set sees an empty team, which is
a visible bug report, whereas the alternative silently shows them the whole
organization.

**Where it applies.** Only endpoints that list *people* need it. Content lists
(courses, assessments, SCORM) are already `contentScope`d and gain nothing from
a department dimension. The affected repository methods are the ones behind:

- `GET /api/admin/users`, `GET /api/admin/employees`
- `GET /api/learner/team` (new, §4)
- department analytics in `reports` — see §8.2 for the honest limit here.

### 3.6 Forced re-login (decision 5)

`permissions[]` travels in the JWT, so the permission check itself costs no
query. But a claim in a 7-day token cannot be revoked, and decision 5 requires
that a permission change take effect. So the token also carries the
organization's `perm_version`:

```json
{ "userId": 5, "organizationId": 10, "role": "learner",
  "roleId": 7, "permissions": ["view_dashboard", "view_team_learning"],
  "permVersion": 4, "email": "...", "firstName": "...", "lastName": "...",
  "exp": 1788000000 }
```

- Any write to `roles` or `role_permissions` bumps
  `organizations.perm_version` **in the same transaction**.
- `AuthGuard` compares the token's `permVersion` against the organization's
  current value. A mismatch is a `401`, which the client already handles by
  redirecting to `/login` — so the effect is exactly "everyone in that
  organization re-logs in", scoped to that organization.

**This must not be cached with a TTL.** `modules/scorm/entitlement-cache.ts`
documents its own stale-positive window and then says, in its docblock, that the
pattern *"must not be reused as a pattern anywhere a capability (rather than a
page or an image) is granted."* A permission is precisely that. So:

- **Chosen for phase 1:** read `organizations.perm_version` per authenticated
  request — a single-row primary-key lookup.
- **The cost, stated honestly:** `AuthGuard` does **zero** I/O today. This adds
  one indexed read to every authenticated request. That is the main performance
  risk in this spec and it must be measured against the 150 ms budget in
  `tenancy-perf-benchmarks` before merge.
- **Documented fallback if it does not hold:** an in-process cache invalidated
  by Postgres `LISTEN`/`NOTIFY` (correct across instances, no staleness), *not*
  a TTL. A TTL fallback would need a written decision that a few seconds of
  stale capability is acceptable, and this spec does not grant that.

### 3.6.1 The trainer portal (decisions 6–8)

**The blocker this had to solve first.** `sessions.trainer` is
`TEXT NOT NULL` — a name typed into a box. Nothing links a session to a
trainer's `users` row, so "his assigned sessions" was not expressible at all.

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS trainer_user_id integer;

-- Deliberate script, not boot (ADD CONSTRAINT has no IF NOT EXISTS):
ALTER TABLE sessions
  ADD CONSTRAINT sessions_trainer_same_org
  FOREIGN KEY (organization_id, trainer_user_id) REFERENCES users (organization_id, id);
```

Nullable and additive: existing sessions keep their `trainer` text, which stays
as the display name and the value the admin form has always shown. A session
with no `trainer_user_id` simply belongs to no trainer's portal — it is not
broken, it is just unassigned. The admin session form gains a trainer picker
(users whose role is `trainer`, in the same org) and writes both columns.

**Modules.** The trainer portal carries exactly these, and nothing else:

| Module | Route | Reads |
|---|---|---|
| My Sessions | `/trainer/sessions` | sessions where `trainer_user_id = me` |
| Session detail | `/trainer/sessions/:id` | that session, plus its companion course |
| Participants | (within session detail) | the roster, with each learner's attendance state |
| Mark Attendance | (within session detail) | writes `session_attendance` for that session |
| Training Calendar | `/trainer/calendar` | his own sessions, month view |
| Profile / Change password | footer | the existing learner-portal screens |

Deliberately absent: users, courses, assessments, reports, certificates, other
trainers' sessions, and any learner who is not on one of his rosters.

**Participants show name, department and attendance state — not email.** A
trainer needs to know who is in the room, not how to contact them; widening
that is a PII decision for the owner (§7.5).

**Permissions.** Three new catalogue entries, and the two the decisions
withhold are simply never granted to a trainer role:

| Permission | Trainer | Note |
|---|---|---|
| `view_own_sessions` | ✅ | scoped to `trainer_user_id = me` |
| `view_session_participants` | ✅ | only for his own sessions |
| `mark_attendance` | ✅ | only for his own sessions |
| `complete_session` | ❌ | decision 7 — credits learners, so admin only |
| `manage_session_roster` | ❌ | decision 8 — creates course assignments, so admin only |

**Row scope reuses `self`.** For a trainer, "self" means *sessions where I am
the trainer*, exactly as it means "my own rows" for a learner. No fourth scope
value is introduced; the repository resolves what `self` means from the table
it is querying.

**Enforcement is two-layered, and the first layer is enough on its own.**
`@Roles('trainer')` keeps a non-trainer out of the endpoints entirely, and
every query additionally filters `trainer_user_id = user.userId`. So a trainer
cannot reach another trainer's session even with a guessed id, and cannot reach
it before `PermissionsGuard` exists at all — which is why this portal can ship
ahead of the `permissions[]` claim.

### 3.7 Seeding roles for a new organization

`OrganizationsService.createOrganization` seeds three **system** roles, so an
organization is never created without a way to administer it:

| key | label | portal | scope | permissions |
|---|---|---|---|---|
| `admin` | Admin | `admin` | `org` | all of `PERMISSIONS` |
| `manager` | Manager | `learner` | `department` | `view_dashboard`, `view_reports`, `view_team_learning` |
| `learner` | Learner | `learner` | `self` | none |

`manager` is seeded because decision 1 names it, but it is an ordinary row: an
org may delete it, rename it, or add `trainer` beside it. `is_system` marks the
three so the lockout guards in §3.8 have something to hold on to.

**This paragraph described intent, not code, until 2026-09-09.**
`createOrganization` only ever inserted the `organizations` row, so every
organization created through the platform UI came up with **zero roles**. Since
`users.role_id` is NOT NULL and the composite FK requires a role from the same
organization, such an org could not be given a single user: the create-user
endpoint answered 404 "Role not found" and the picker had nothing in it. A new
tenant was unusable from the moment it was created, and the only way in was a
hand-written INSERT. The seeding now happens in the same transaction as the
organization row — a half-created tenant is precisely the state worth making
impossible, and it cannot be repaired by retrying because the second attempt
trips the unique slug.

`trainer` is still deliberately absent (see `TRAINER_ROLE`): not every
organization runs its own training. A super-admin adds it from the roles screen
for the ones that do, which is §3.9.

### 3.8 Lockout guards

Mirroring the guard in `reset-to-admin-only.mjs`, which refuses to leave an
organization with no admin. All four are enforced in the service, with 422:

1. An organization must always retain at least one role with `portal = 'admin'`
   **and** `manage_roles`.
2. That role must always have at least one active user.
3. You cannot remove `manage_roles` from **your own** role. (The mock already
   gestures at this with `LOCKED = new Set(["manage_users"])`.)
4. A role holding users cannot be deleted — reassign them first. The composite
   FK in §3.4 has no `ON DELETE SET NULL`, so this is also structural.

---

### 3.9 Delegated administration (decision 9)

§8.3 recorded "no delegated administration" as an open question: an org admin
could only ever manage their own organization, and a platform admin could not
touch another organization's roles at all. The product owner has now decided
they should be able to — a super-admin looking at an organization must be able
to define its roles and create a user on any of them, an extra admin, a trainer
or a learner, without borrowing that org admin's credentials.

**It is delegation, not a second implementation.** Every rule in §3.2, §3.7 and
§3.8 keeps applying, because the platform routes call the same
`RolesService` with a different scope. Nothing about *what* a role may hold
changes when a super-admin is the one ticking the boxes; only which
organization is being edited.

That "different scope" is the whole design problem. `OrgScope` is a branded
type whose only minter is `TenantContextGuard`, reading `organizationId` from
the verified JWT — precisely so that a body, a query param or a header can
never become a tenant scope (`multi-tenancy.md` §3.1). A platform admin acting
on organization 11 needs a scope for 11 while their own token says 9, so a
second minter is unavoidable. It is `OrganizationsService.scopeFor()`, and it
is safe for three reasons that must all hold:

1. it is reachable only from `@PlatformAdmin()` routes, so the caller is
   already proven to be an admin **of the platform organization**;
2. it resolves the id against a real `organizations` row first, so an invented
   id is a 404 rather than a scope over nothing;
3. it lives on the one service that already owns cross-organization reads, so
   there is a single place to audit rather than a helper any module may reach
   for.

Four consequences worth stating, because each is a place this could have been
got wrong:

- **The lockout guards still fire.** A super-admin cannot strip `manage_roles`
  from an organization's last admin role, or delete a role that holds users
  (§3.8, guards 1, 2 and 4). Those guards protect the *tenant*, and the tenant
  is no less exposed because the person editing sits above them. A super-admin
  who genuinely wants that shape creates the replacement role first.
- **Guard 3 still fires, for the right reason.** "You cannot remove
  `manage_roles` from your own role" is evaluated by comparing the actor's
  `roleId` against the role being edited. `roles.id` is a global sequence, so
  a platform admin's role id can never collide with a role in another
  organization and the guard is simply inert there — while it still protects
  them when the organization they are editing IS the platform organization.
  The actor's real `roleId` is therefore passed through unchanged, with no
  cross-org special case to get wrong.
- **The forced re-login lands on the edited organization, not the editor.**
  A write bumps `organizations.perm_version` for the org in scope (§3.6), so
  editing organization 11's roles signs out organization 11 and leaves the
  super-admin's own session alone. The UI must say *"everyone in Invensis
  Technologies"*, never *"including you"* — the org-admin screen's copy is
  wrong here, and wrong in the direction that makes a super-admin hesitate
  before a change that costs them nothing.
- **Creating a user is create-then-assign, not a third role writer.** The
  insert supplies `role_id` and `role` from one resolved role row (§3.4), and
  `RolesService.assign` remains the only method that *moves* a user between
  roles.

**Not in scope, deliberately.** A super-admin cannot list or reassign an
organization's existing users from the platform portal. That is the org admin's
`/admin/users` screen, and duplicating it would mean a second employee-listing
surface with its own department scoping to keep in step. Creating a user is
enough to unblock an organization that has locked itself out; re-shuffling one
that has not is that organization's own business.

---

## 4. API contract

All under the existing `/api` prefix. Every route is authenticated by default
(`AuthGuard` is global, tenancy §5.2); the Auth column lists what is added.

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| GET | `/admin/permissions` | `@Roles('admin')` | — | `{ permissions: [{ id, label }] }` — the code catalogue |
| GET | `/admin/roles` | `@Roles('admin')` | — | `{ roles: [{ id, key, label, portal, scope, isSystem, userCount, permissions[] }] }` |
| POST | `/admin/roles` | `@Permissions('manage_roles')` | `{ key, label, portal, scope, permissions[] }` | `201 { role }` |
| PATCH | `/admin/roles/:id` | `@Permissions('manage_roles')` | `{ label?, scope?, permissions[]? }` | `{ role }` |
| DELETE | `/admin/roles/:id` | `@Permissions('manage_roles')` | — | `{ ok: true }` — 422 if it holds users or is the last admin role |
| PATCH | `/admin/users/:id/role` | `@Permissions('manage_users')` | `{ roleId }` | `{ user }` — also rewrites `users.role` from the role's portal |
| GET | `/learner/team` | `@Permissions('view_team_learning')` | — | `{ team: [{ id, name, department, coursesAssigned, coursesCompleted, progressPct, hours, lastActiveAt }], summary }` |
| GET | `/trainer/sessions` | `@Roles('trainer')` | — | `{ sessions: [...] }` — only `trainer_user_id = me` |
| GET | `/trainer/sessions/:id` | `@Roles('trainer')` | — | `{ session, course }` — 404 if not his |
| GET | `/trainer/sessions/:id/participants` | `@Roles('trainer')` | — | `{ participants: [{ id, name, department, status, markedAt }] }` |
| PUT | `/trainer/sessions/:id/attendance` | `@Roles('trainer')` | `{ records: [{ userId, status }] }` | `{ ok: true }` — 404 if not his |
| GET | `/admin/trainers` | `@Roles('admin')` | — | `{ trainers: [{ id, name }] }` — for the session form's picker |
| GET | `/platform/organizations/:orgId/roles` | `@PlatformAdmin()` | — | `{ permissions, roles }` — that org's roles with full `permissions[]`, plus the code catalogue |
| POST | `/platform/organizations/:orgId/roles` | `@PlatformAdmin()` + `manage_roles` | `{ key, label, portal, scope, permissions[] }` | `201 { roles, permVersion }` |
| PATCH | `/platform/organizations/:orgId/roles/:roleId` | `@PlatformAdmin()` + `manage_roles` | `{ label?, scope?, permissions[]? }` | `{ roles, permVersion }` |
| DELETE | `/platform/organizations/:orgId/roles/:roleId` | `@PlatformAdmin()` + `manage_roles` | — | `{ roles, permVersion }` |
| POST | `/platform/organizations/:orgId/users` | `@PlatformAdmin()` + `manage_users` | `{ firstName, lastName, email, password, roleId }` | `201 { user }` — replaces `POST /:id/admins` |

`userCount` on the roles list is a single grouped count — not a query per role
(`BACKEND_STRUCTURE.md` §7.1). The mock's hardcoded `users: 1 / 2 / 18` is what
this replaces.

`GET /learner/team` is scoped by `ActorScope`, so it returns the actor's
department within the actor's organization, in **one** query with the learning
figures aggregated in SQL — reusing `learning-hours`' `lessonSource` fragment
rather than defining a second notion of an hour (§10.4 of
`BACKEND_STRUCTURE.md` exists precisely to stop that).

### 4.1 New decorator and guard

```ts
@Permissions('manage_roles')      // implies authenticated; ANDs with @Roles if both present
```

`PermissionsGuard` runs after `RolesGuard`, reads `request.user.permissions`,
and throws `ForbiddenException` (403) when a required permission is absent.
403 rather than 404 here is deliberate and differs from the tenancy rule: a
cross-tenant id must 404 because its existence is a secret, whereas
"you may not manage roles" leaks nothing — the button simply is not yours.

---

## 5. UI

### 5.1 `/admin/roles` — replace the mock

Currently `components/admin/admin-roles-content.jsx` holds `PERMISSIONS`,
`ROLES`, `DEFAULTS` and `LOCKED` as module constants and its entire save path is
`const save = () => setSaved(true)`. It becomes a real client widget:

- fetches `/admin/permissions` and `/admin/roles`;
- the permission matrix keeps its current shape (permissions as rows, roles as
  columns) but the columns come from the org's own roles, so a fourth column
  appears when an org adds `trainer`;
- **Add role** and **Delete role** actions, plus per-role `label` and `scope`;
- Save calls `PATCH /admin/roles/:id` and then — because decision 5 forces a
  re-login — warns before writing: *"Everyone in your organization will be
  signed out and will need to sign in again."* Confirm, then save, then the
  admin's own next request 401s and lands them on `/login`. That is the designed
  behaviour, and the dialog is what stops it reading as a crash.
- The subtitle *"enforced live across the app"* becomes true. Until this ships it
  is false and should be changed (§8.1).

### 5.2 Learner nav gating

`lib/nav-config.js` items gain an optional `permission`. The shared
`SidebarNavGroup` / `SidebarNavFooter` in `components/layout/sidebar-nav.jsx`
filter items whose permission the session lacks — one place, because those three
sidebars were unified. `lib/session.js` carries `permissions` through from
`/api/auth/me`.

Client filtering is **cosmetic only**; the API enforces. This is the same stance
`middleware.js` already documents about itself ("a navigation gate, not a
security boundary").

### 5.3 Team Learning — make it real

`components/learner/team-learning-content.jsx` currently renders a hardcoded
`TEAM_MEMBERS` array and makes no API call, and `nav-config.js` shows it to
**every** learner. It becomes a client widget fetching `/learner/team`, with a
`loading.js` skeleton matching the real layout, an empty state for a manager
whose department has no other members, and the nav item gated on
`view_team_learning`.

---

### 5.4 `/platform/organizations/[id]` — delegated administration

The super-admin's organization page was read-only about roles (a count of
permissions per role) and could seed exactly one thing: an admin. It now
carries the same role editing the org admin has, plus a create-user form with a
role picker (§3.9).

Two things differ from `/admin/roles`, and both are copy rather than code:

- the sign-out warning names **that organization** and adds "Your own session
  is not affected", because a role write bumps the edited org's `perm_version`
  and not the platform org's. The org-admin screen's "including you" is correct
  there and would be wrong here;
- the create-user form shows what the chosen role means before the button is
  pressed — which portal the person will land in, how wide their people-reads
  are, and how many permissions they hold — because picking "Trainer" versus
  "Admin" is the decision this screen exists to make.

The matrix and the add-role dialog are shared
(`client/components/shared/role-editor.jsx`), so the two screens cannot drift
apart on what a role is. That component is also where the matrix's column
floors live: `minmax(11rem, 1fr)` per §3.2.1's wider catalogue, because at six
roles the fixed 7rem columns had consumed the whole `min-w-[40rem]` and the
label column had collapsed to 40px.

---

## 6. Acceptance criteria

1. `roles` and `role_permissions` exist; `users.role_id` and
   `organizations.perm_version` exist; every migration statement is re-runnable.
2. `users.role` is still exactly `admin | learner`, and all 22 existing
   `@Roles()` decorators are unmodified.
3. Assigning a user a `role_id` belonging to another organization is rejected by
   **Postgres**, not by application code (verified by attempting it directly in SQL).
4. A permission key absent from `common/permissions.ts` is rejected with 422 on
   role create and role update.
5. A new organization is created with the three system roles of §3.7 and at
   least one admin-capable role.
6. All four lockout guards of §3.8 return 422 and are individually exercised.
7. Saving a permission change bumps `perm_version` in the same transaction, and
   the next request from **any** user in that organization returns 401.
8. A user in another organization is **not** signed out by that change.
9. A `department`-scoped role listing employees returns only same-department
   rows; a `self`-scoped role listing them gets 403; an `org`-scoped role gets all.
10. A manager whose `users.department` is NULL gets an empty team, never the
    whole organization.
11. `GET /learner/team` costs one query regardless of team size (asserted by
    query log or by review), and its hours agree with `/learner/learning-hours`
    for the same person.
12. `/admin/roles` renders the org's real roles, and an added `trainer` role
    appears as a fourth column without a code change.
13. `npm run test:isolation` still passes, extended with §6b's escalation cases.
14. `npm run build` passes in both packages.

### 6a. End-to-end user journeys

- **Configure a role (happy path).** As an Edstellar admin I open
  `/admin/roles`, add a role "Trainer" with portal *learner*, scope
  *department*, permissions *view_team_learning* and *view_reports*, and press
  Save & Apply → I confirm the sign-out warning → I am returned to `/login`. I
  sign in again, reopen `/admin/roles`, and Trainer is there with those exact
  permissions. **Trigger:** the Add role button; the Save & Apply button.
- **Assign it.** As that admin I open `/admin/users`, edit a learner, set their
  role to Trainer → the list shows their new role. **Trigger:** the role select
  in the edit-user dialog → `PATCH /admin/users/:id/role`.
- **Use it.** As that trainer I sign in → I land in the **learner** portal (not
  admin) → the sidebar now shows **Team Learning** → opening it lists only
  people whose department equals mine, with real progress and hours.
  **Trigger:** the sidebar item → `GET /learner/team`.
- **Lose it.** As the admin I remove `view_team_learning` from Trainer and save →
  the trainer's next click 401s them to `/login`; after signing in, Team
  Learning is gone from their sidebar, and calling `/api/learner/team` directly
  returns 403.
- **Cannot escalate.** As that trainer I call `POST /api/admin/roles` directly →
  403. As an Edstellar admin I call `PATCH /api/admin/roles/:id` with an
  Invensis role id → 404.
- **Cannot lock myself out.** As the only admin I try to remove `manage_roles`
  from my own role → 422 with a message saying why, and nothing is written.

#### Journey 6 — a super-admin sets up another organization (§3.9)

1. Sign in as the platform admin, open an organization.
2. Add a role ("Coordinator", admin portal, whole organization) and tick
   `view_dashboard`, `view_reports`, `view_certificates`. The matrix gains a
   column; the notice names that organization and says your own session is
   unaffected.
3. Create a user on it. They can sign in, land in the admin portal, and see a
   sidebar of Dashboard plus the four analytics items — no Manage Users, no
   Content Library, no Sessions, no Roles.
4. Their writes 403: users, courses, sessions, certificates, scorm.
5. That organization's own admin is signed out by step 2 and back to normal
   after signing in again. The other organization's admin is never affected.

---

### 6b. Isolation-suite extension

A privilege escalation is silent in exactly the way a tenancy leak is — nothing
throws, the wrong button simply works — so it gets the same treatment as
`specs/multi-tenancy.md` §7.6. Add to `scripts/test-isolation.mjs`:

- every `@Permissions()` route called by a role lacking that permission → 403;
- an admin of org A patching a role of org B → 404;
- a `department`-scoped actor's people-list containing only their department;
- `perm_version` bump signing out org A and **not** org B;
- a role id from org B assigned to a user in org A → rejected by the FK.

---

## 7. Human checkpoints

1. **The migration in §3–3.4.** Additive DDL, then a backfill mapping every
   existing user to a seeded system role, then `SET NOT NULL` on
   `users.role_id`. Non-additive, so it is a deliberate script in the shape of
   `scripts/migrate-tenancy.mjs` — dry-run by default, `--commit` to apply,
   one transaction, verification pass before commit.
2. **The forced sign-out.** Shipping the `permVersion` check invalidates every
   existing token once, exactly as the `organizationId` claim did
   (`BACKEND_STRUCTURE.md` §5.1). Deploy it knowing that.
3. **The per-request `perm_version` read** (§3.6) — measure it before merge and
   decide explicitly whether to keep it or move to `LISTEN`/`NOTIFY`.
4. **The department boundary** (§8.2) — it is a security boundary keyed off a
   free-text column. Sign that off knowingly, or fund the `departments` table.
5. **PII.** `/learner/team` shows one employee's progress to another employee.
   That is the feature, but it is new PII exposure and needs an owner's yes.
6. **The four public passwords are accepted on staging, deliberately, and must
   not survive the move to production.** Decided 2026-09-10.

   `Platform@123`, `Admin@123`, `Learner@123` and `Invensis@123` are committed
   in this repository — they appear in `scripts/seed.mjs`, in
   `specs/multi-tenancy.md`, and in `PUBLIC_PASSWORDS` in
   `scripts/create-platform-admin.mjs`, which refuses them unless
   `--allow-public-password` is passed. The owner has accepted them on the
   staging environment to keep testing moving, and the guard is opt-out per
   run rather than removed, so nothing about production changes by accident.

   **Before production go-live, rotate all four**, starting with the platform
   admin, since it is the only account that can reach every organization:

   ```bash
   node scripts/create-platform-admin.mjs --email <super-admin> \
     --reset-password --commit          # prompts twice, hidden; no flag needed
   ```

   Org admins, trainers and learners change theirs through
   `POST /api/auth/change-password` (the Change Password screen), or an admin
   recreates the account. A reset bumps that user's `perm_version`, so any
   session already issued with the old password stops working — which is the
   point.

   Do NOT fix this by deleting the `PUBLIC_PASSWORDS` guard. Its whole value is
   the day someone runs the bootstrap command against production out of habit.

### 7.1 Deploying this to a server that has not run it before

The order matters, because two of the steps are deliberate scripts and the
third is a boot migration that depends on the second having happened:

```bash
# 0. before deploying anything — what state is this database in?
npm run db:verify:rbac

# 1. deploy the code and start it once. Boot applies the ADDITIVE migrations
#    (0007 organizations, 0011 roles, 0013 user perm_version, 0014 catalogue).
#    If no organization has is_platform = true, THE API REFUSES TO BOOT — that
#    is deliberate (see OrganizationsService.onModuleInit) and step 2 fixes it.

# 2. tenancy: creates the platform org, backfills, adds the composite FKs
npm run db:migrate:tenancy               # dry run — runs everything, rolls back
npm run db:migrate:tenancy -- --commit

# 3. RBAC: seeds each org's system roles, backfills users.role_id, SET NOT NULL
npm run db:migrate:rbac                  # dry run
npm run db:migrate:rbac -- --commit

# 4. restart the API so 0014 grants manage_certificates + manage_sessions to
#    the admin roles step 3 just created, and bumps perm_version once

# 5. the super-admin account — nothing else can create the first one
npm run db:create-platform-admin -- --commit
#    ...or, if the account already exists and the password is unknown:
#    node scripts/create-platform-admin.mjs --email <addr> --reset-password --commit
#    On STAGING, add --allow-public-password to accept a committed password
#    (checkpoint 6 above — it must be rotated before production).

# 6. confirm
npm run db:verify:rbac
```

`db:verify:rbac` is read-only and safe against production at any time. It
checks STATE rather than which scripts ran, because a database restored from a
backup has no record of the latter, and prints the exact next command for
every failure.

**Everyone is signed out once**, at step 4 — the `permVersion` claim changes
(checkpoint 2 above). Expect it and say so in advance rather than fielding
"I got logged out" tickets.

`migrate-rbac.mjs` refuses to run a second time once roles exist. That is
correct: from then on roles are edited through the UI (§3.9), not by re-running
a migration.

---

## 8. Non-goals / risks

### 8.1 Two mocks are shipping today and claim to be real

Independent of when RBAC is built, both of these are live in the deployed app:

- **`/admin/roles`** — the save handler is `() => setSaved(true)`. It shows 12
  permissions across 3 roles with hardcoded user counts, a `manager` role that
  does not exist in the enum, and the subtitle *"enforced live across the app"*.
  An admin can tick boxes, see "Saved!", and reasonably believe access control
  changed.
- **`/team-learning`** — a hardcoded `TEAM_MEMBERS` array, shown to **every**
  learner, with invented names, progress and hours.

**Both are now real** — `/admin/roles` reads the catalogue and the
organization's roles and writes through the API, and `/team-learning` reads
`GET /learner/team` behind `view_team_learning`. This subsection is kept as the
record of what was wrong, not as outstanding work.

### 8.2 Department scope rests on a free-text column

`users.department` is `TEXT` with an index and no referential integrity; there
is no departments table. There are **181 references** to department across the
two packages (97 server, 84 client), and string equality is already used as a
filter for bulk enrolment (`scorm.repository.ts:335`,
`sessions.repository.ts:184`), while analytics groups by it in SQL and then
matches it again in JavaScript.

Consequences, accepted deliberately for phase 1:

- Renaming a department changes who a manager can see, silently.
- `"Engineering"` and `"Engineering "` are different departments, and the
  difference is invisible in the UI.
- Mitigation in scope: **normalise on write** (trim, collapse internal
  whitespace) wherever `department` is set, which closes the whitespace class of
  bug additively.
- Deferred: a `departments` table with `users.department_id`. It is the correct
  model for a security boundary, and it is a migration touching those 181
  references — larger than this spec. Revisit before an organization has more
  than a handful of managers.

### 8.3 Other risks

- **`users.role` is denormalised** from `roles.portal`. Exactly one service
  method may write it. If a second appears, the two can disagree and a manager
  lands in the admin portal.
- **A 7-day token holding `permissions[]`** is only safe because of the
  `perm_version` check. Removing that check to save the read would silently
  reintroduce week-long stale permissions.
- **`@Permissions()` on a route with no `@Roles()`** is authenticated-any-role.
  That is correct for `/learner/team` and wrong for anything admin-shaped; the
  reviewer checklist should call it out.
- ~~**No delegated administration.**~~ **Decided and built — §3.9.** A platform
  admin can now define any organization's roles and create a user on any of
  them, by calling the same `RolesService` with a scope minted for the target
  org. The residual risk moves to `OrganizationsService.scopeFor()`: it is the
  only minter of an `OrgScope` that does not come from the caller's own JWT, so
  a route that calls it without `@PlatformAdmin()` would be a cross-tenant
  write. Its docblock says so; the reviewer checklist should treat any new
  caller as a finding until proven otherwise.
- **RLS (phase 2) will need to know about scope.** When it lands, a
  `department`-scoped policy has to agree with `ActorScope`, or the two
  enforcement layers will disagree. Note it in that spec when written.
