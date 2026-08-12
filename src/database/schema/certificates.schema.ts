import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

import { courses } from './courses.schema';
import { users } from './users.schema';

/**
 * One certificate per learner per course. Revocation is a soft delete
 * (`isRevoked = 1`) so the audit trail survives — rows are never deleted.
 */
export const certificates = sqliteTable(
  'certificates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    /** Server-generated only: EDS-<courseId>-<userId>-<shorthash>. */
    certificateCode: text('certificate_code').notNull().unique(),
    issuedAt: text('issued_at').notNull(),
    /** Best assessment % at issuance, or NULL when the course has no assessment. */
    finalScore: integer('final_score'),
    isRevoked: integer('is_revoked').notNull().default(0),
    revokedAt: text('revoked_at'),
    revokedBy: integer('revoked_by').references(() => users.id),
  },
  (table) => [
    unique('certificates_user_course_unique').on(table.userId, table.courseId),
    // Admin list filters by course; the (user_id, course_id) UNIQUE already
    // covers the learner-side lookup.
    index('idx_certificates_course').on(table.courseId),
  ],
);

export type CertificateRow = typeof certificates.$inferSelect;
export type NewCertificateRow = typeof certificates.$inferInsert;
