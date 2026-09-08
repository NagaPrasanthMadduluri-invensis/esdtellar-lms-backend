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
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
