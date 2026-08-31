import { index, integer, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Mirrors the `users` table, including the four columns that were added by
 * idempotent `ALTER TABLE` migrations in the legacy `lib/db/schema.js`
 * (employee_id, location, job_role).
 *
 * `role` is the authoritative role vocabulary: 'admin' | 'learner'.
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
    role: text('role', { enum: ['admin', 'learner'] })
      .notNull()
      .default('learner'),
    department: text('department'),
    employeeId: text('employee_id'),
    location: text('location'),
    jobRole: text('job_role'),
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
    index('idx_users_org_role_active').on(
      table.organizationId,
      table.role,
      table.isActive,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
