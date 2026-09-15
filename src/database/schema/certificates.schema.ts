import { index, integer, pgTable, serial, text, timestamp, unique } from 'drizzle-orm/pg-core';

import { courses } from './courses.schema';
import { journeys } from './journeys.schema';
import { users } from './users.schema';

/**
 * One certificate per learner per course. Revocation is a soft delete
 * (`isRevoked = 1`) so the audit trail survives — rows are never deleted.
 */
export const certificates = pgTable(
  'certificates',
  {
    id: serial('id').primaryKey(),
    /** Activity: the certified user's org. */
    organizationId: integer('organization_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * NOT NULL here still — a course certificate. A journey certificate
     * (`journeyId` below) is the exception, and relaxing this to nullable plus
     * the `(course_id IS NULL) <> (journey_id IS NULL)` CHECK is a non-additive
     * change left to `scripts/migrate-journey-certificates.mjs`, a human
     * checkpoint (`specs/learning-journeys.md` §3.4).
     */
    courseId: integer('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'cascade' }),
    /**
     * Set for a journey certificate instead of a course one — mutually
     * exclusive with `courseId` once the checkpoint script's CHECK constraint
     * lands (§3.4). Code: `EDS-J<journeyId>-<userId>-<shorthash>`, the `J`
     * telling the two apart by eye in a support ticket.
     */
    journeyId: integer('journey_id').references(() => journeys.id, {
      onDelete: 'cascade',
    }),
    /** Server-generated only: EDS-<courseId>-<userId>-<shorthash>. */
    certificateCode: text('certificate_code').notNull().unique(),
    issuedAt: timestamp('issued_at', {
      mode: 'string',
      withTimezone: true,
    }).notNull(),
    /** Best assessment % at issuance, or NULL when the course has no assessment. */
    finalScore: integer('final_score'),
    isRevoked: integer('is_revoked').notNull().default(0),
    revokedAt: timestamp('revoked_at', { mode: 'string', withTimezone: true }),
    revokedBy: integer('revoked_by').references(() => users.id),
  },
  (table) => [
    unique('certificates_user_course_unique').on(table.userId, table.courseId),
    // Admin list filters by course; the (user_id, course_id) UNIQUE already
    // covers the learner-side lookup.
    index('idx_certificates_course').on(table.courseId),
    index('idx_certs_org_user').on(table.organizationId, table.userId),
  ],
);

export type CertificateRow = typeof certificates.$inferSelect;
export type NewCertificateRow = typeof certificates.$inferInsert;
