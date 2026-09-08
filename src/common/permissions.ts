/**
 * The permission catalogue — `specs/rbac.md` §3.2.
 *
 * THIS FILE IS THE CATALOGUE. The database stores which roles hold which
 * permissions; it does not store what permissions exist. That split is
 * deliberate and it is the safety property of the whole feature:
 *
 *   a permission string means something ONLY because a guard checks it.
 *
 * So adding a permission is a code change, reviewed next to the guard that
 * enforces it. If the catalogue were data too, an org admin could create
 * `delete_everything` in the roles UI and it would sit there enforcing
 * nothing — which is exactly the failure the current `/admin/roles` mock has,
 * and it must not survive into the real implementation.
 *
 * `RolePermissionsService` validates every incoming key against `PERMISSIONS`
 * and rejects an unknown one with 422. A permission REMOVED from this object
 * leaves harmless orphan rows in `role_permissions` that no guard reads — the
 * grant simply stops meaning anything, which is the correct direction to fail.
 */

/**
 * Permission id -> the label the roles UI shows.
 *
 * The first twelve are the ones the existing `/admin/roles` screen already
 * lists, keyed identically, so wiring that screen up does not change a single
 * label the admin has already seen. The rest are added by this feature:
 * `manage_roles` is what it needs to guard itself, `view_team_learning` is the
 * manager's extra module (decision 2), and the last five belong to the trainer
 * portal — of which two, `complete_session` and `manage_session_roster`, exist
 * precisely so a trainer role can be seen NOT to hold them (decisions 7, 8).
 */
export const PERMISSIONS = {
  view_dashboard: 'View dashboard',
  view_employees: 'View employees',
  edit_employees: 'Edit employees',
  upload_content: 'Upload content',
  build_assessments: 'Build assessments',
  assign_learning: 'Assign learning',
  manage_users: 'Manage users',
  view_reports: 'View reports',
  manage_courses: 'Manage courses',
  manage_assessments: 'Manage assessments',
  manage_departments: 'Manage departments',
  view_certificates: 'View certificates',
  manage_roles: 'Manage roles and permissions',
  view_team_learning: 'View team learning',
  // Trainer portal (`specs/rbac.md` §3.6.1). Each is additionally scoped to
  // sessions where the caller IS the trainer — the permission says whether he
  // may do it at all, `trainer_user_id = me` says to which sessions.
  view_own_sessions: 'View own training sessions',
  view_session_participants: 'View session participants',
  mark_attendance: 'Mark session attendance',
  // Deliberately NOT granted to a trainer (decisions 7 and 8): completing a
  // session credits every attendee with the training, its hours and its
  // completion, and a roster change creates course assignments. Both stay with
  // an org admin. They are catalogued so the roles UI can show them as
  // withheld rather than absent.
  complete_session: 'Mark a session completed',
  manage_session_roster: 'Add or remove session participants',
} as const;

/** Every valid permission id. */
export type Permission = keyof typeof PERMISSIONS;

/** Ordered ids — the order the roles UI renders its rows in. */
export const PERMISSION_IDS = Object.keys(PERMISSIONS) as Permission[];

/** Shape the roles UI receives from `GET /api/admin/permissions`. */
export interface PermissionDescriptor {
  id: Permission;
  label: string;
}

export const PERMISSION_CATALOGUE: PermissionDescriptor[] = PERMISSION_IDS.map(
  (id) => ({ id, label: PERMISSIONS[id] }),
);

/** Narrowing guard for anything arriving from a request body or the database. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && value in PERMISSIONS;
}

/**
 * Keeps only the ids this build actually enforces, preserving catalogue order.
 *
 * Used when reading `role_permissions` back out: a row naming a permission
 * this build no longer has must not reach a JWT claim, or a guard added later
 * under the same name would silently honour a grant nobody reviewed.
 */
export function filterKnownPermissions(values: readonly unknown[]): Permission[] {
  const held = new Set(values.filter(isPermission));
  return PERMISSION_IDS.filter((id) => held.has(id));
}

/**
 * Which portal a role's holders land in (`roles.portal`).
 *
 * A closed, small set — NOT one per role. A role earns a portal only when its
 * work has no home in an existing one (`specs/rbac.md` §3.1.1):
 *
 * - `learner` — a manager lives here, because their work is learner-shaped:
 *   their own learning plus a view of their team's (decision 2).
 * - `trainer` — a trainer lives here, because running sessions is neither
 *   learner-shaped nor admin work, and decision 6 is explicit that he is not
 *   an admin.
 *
 * `users.role` is written from this and remains the portal selector. It is
 * plain `TEXT` in Postgres with no CHECK constraint, so adding `trainer` costs
 * no column migration. The 22 existing `@Roles()` decorators stay untouched:
 * a trainer matches none of them, which is the point.
 */
export const ROLE_PORTALS = ['admin', 'learner', 'trainer'] as const;
export type RolePortal = (typeof ROLE_PORTALS)[number];

/**
 * How wide a role's people-reads are (`roles.scope`) — `specs/rbac.md` §3.5.
 *
 * This is the row dimension, orthogonal to the permission itself: `view_employees`
 * says *whether* you may list employees, `scope` says *which* ones. Resolved
 * server-side from the actor's own row, never from a request parameter — the
 * same rule `organizationId` follows, because a scope a client can name is a
 * scope a client can widen.
 */
export const ROLE_SCOPES = ['org', 'department', 'self'] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

/**
 * The roles every organization is created with (§3.7).
 *
 * `manager` is seeded because the owner named it, but it is an ordinary row:
 * an org may rename it, delete it, or add `trainer` beside it. `isSystem` only
 * marks the three so the lockout guards have something to hold on to — it does
 * not make them special to any guard.
 */
export interface SystemRoleSeed {
  key: string;
  label: string;
  portal: RolePortal;
  scope: RoleScope;
  permissions: readonly Permission[];
}

export const SYSTEM_ROLES: readonly SystemRoleSeed[] = [
  {
    key: 'admin',
    label: 'Admin',
    portal: 'admin',
    scope: 'org',
    permissions: PERMISSION_IDS,
  },
  {
    key: 'manager',
    label: 'Manager',
    portal: 'learner',
    scope: 'department',
    permissions: ['view_dashboard', 'view_reports', 'view_team_learning'],
  },
  {
    key: 'learner',
    label: 'Learner',
    portal: 'learner',
    scope: 'self',
    permissions: [],
  },
] as const;

/**
 * NOT part of `SYSTEM_ROLES`, on purpose.
 *
 * Not every organization runs its own training, so seeding a trainer role into
 * all of them would put an empty role in front of every admin. It is created
 * per organization on request — `scripts/create-org-role.mjs`, or the roles UI
 * once that ships — and this is the shape it is created with.
 */
export const TRAINER_ROLE: SystemRoleSeed = {
  key: 'trainer',
  label: 'Trainer',
  portal: 'trainer',
  scope: 'self',
  permissions: ['view_own_sessions', 'view_session_participants', 'mark_attendance'],
};

/**
 * The role an existing user is backfilled onto, from the `users.role` they
 * already have. `users.role` is the portal selector, so this mapping is total
 * and lossless in that direction — every current user is either an admin or a
 * learner, and nobody is currently a manager because the role did not exist.
 */
export const BACKFILL_ROLE_KEY: Record<'admin' | 'learner', string> = {
  admin: 'admin',
  learner: 'learner',
};
