import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Mirrors the `users` table, including the four columns that were added by
 * idempotent `ALTER TABLE` migrations in the legacy `lib/db/schema.js`
 * (employee_id, location, job_role).
 *
 * `role` is the PORTAL SELECTOR: 'admin' | 'learner' | 'trainer'. It is plain
 * TEXT in Postgres with no CHECK, so `trainer` (rbac.md decision 6) needed no
 * column migration. Permissions live in `roles`/`role_permissions`, not here.
 */
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    /**
     * The identity axis (spec §3.3): a user carries its own org. Backfilled
     * and set `NOT NULL` in the live database by `scripts/migrate-tenancy.mjs`
     * (spec §3.10) — this mirrors that, so an insert omitting it is now a
     * compile error rather than a runtime constraint violation.
     */
    organizationId: integer('organization_id').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull().unique(),
    password: text('password').notNull(),
    role: text('role', { enum: ['admin', 'learner', 'trainer'] })
      .notNull()
      .default('learner'),
    department: text('department'),
    employeeId: text('employee_id'),
    location: text('location'),
    jobRole: text('job_role'),
    /**
     * Free text, and the person's own to edit (`0029`). No `manager_id`
     * beside it on purpose — there is no reporting line in this product, so
     * the column would render as "—" forever.
     */
    phone: text('phone'),
    /**
     * Seniority band — one of `JOB_LEVELS` in `common/workforce.ts`, or null
     * for a user nobody has set it on yet. Added by
     * `0018_workforce_and_activity_log.sql`.
     *
     * Free text in Postgres, closed by the DTO, for the same reason `role` is:
     * the set of values is a product decision that must not need a migration
     * to change. `job_role` beside it is genuinely free text and that is the
     * difference — this one is a reporting dimension, so its values have to
     * repeat across people.
     */
    jobLevel: text('job_level'),
    /**
     * The org-scoped role that carries this user's permissions and row scope
     * (`specs/rbac.md` §3.4). Nullable here because
     * `0011_rbac_roles.sql` adds it nullable; `scripts/migrate-rbac.mjs`
     * backfills it, adds the composite FK to `roles (organization_id, id)` and
     * then sets it NOT NULL. Mirror that change here when it is applied.
     *
     * `role` above is NOT replaced by this. It remains the portal selector and
     * is written from the role's `portal`, which is what keeps every existing
     * `@Roles()` decorator and route-group layout working unchanged.
     */
    roleId: integer('role_id'),
    /**
     * This user's own token version (`specs/rbac.md` §3.6). Bumped when THEY
     * are moved to another role, so only they are signed out — as opposed to
     * `organizations.perm_version`, which is bumped when a role's permissions
     * change and signs the whole organization out.
     */
    permVersion: integer('perm_version').notNull().default(1),
    isActive: integer('is_active').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_users_role_active').on(table.role, table.isActive),
    index('idx_users_department').on(table.department),
    // Leading organization_id: the most selective predicate once tenancy is
    // live, and the leftmost prefix that supersedes idx_users_role_active
    // (spec §3.7). The single-column index above stays until the reviewed
    // drop in wave 3.
    // Counting holders per role, and listing an org's users by role.
    index('idx_users_org_role_id').on(table.organizationId, table.roleId),
    index('idx_users_org_role_active').on(
      table.organizationId,
      table.role,
      table.isActive,
    ),
    // The two Reports dimensions that filter and group on their own column.
    // `department` is already covered by idx_users_department above.
    index('idx_users_org_job_level').on(table.organizationId, table.jobLevel),
    index('idx_users_org_location').on(table.organizationId, table.location),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
