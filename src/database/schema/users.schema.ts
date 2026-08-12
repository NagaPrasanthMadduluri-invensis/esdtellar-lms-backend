import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Mirrors the `users` table as it exists in Turso today, including the four
 * columns that were added by the idempotent `ALTER TABLE` migrations in the
 * legacy `lib/db/schema.js` (employee_id, location, job_role).
 *
 * `role` is the authoritative role vocabulary: 'admin' | 'learner'.
 */
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    // Learner lists and department analytics filter on these constantly.
    index('idx_users_role_active').on(table.role, table.isActive),
    index('idx_users_department').on(table.department),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
