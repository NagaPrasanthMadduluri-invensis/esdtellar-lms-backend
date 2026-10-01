import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * Training a learner did elsewhere, and the two decisions that let it count
 * (0036).
 *
 * The row is the CLAIM and its approval trail. What an approval produces —
 * a companion course, an assignment and a completion — lives in the tables
 * that already model those things, so hours, My Courses and the completion
 * counts pick it up through definitions that already work (§10.7's pattern).
 *
 * `courseId` has no `.references()` here: `courses.schema.ts` does not
 * import this file, and the reverse reference would make the two circular —
 * the same reason `courses.sessionId` is declared bare. The foreign key is
 * in migration 0036.
 */
export const externalCertifications = pgTable(
  'external_certifications',
  {
    id: serial('id').primaryKey(),
    /** Activity: always the learner's own org. */
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * What the certificate itself says, which is not always what `users`
     * says. An approver comparing the document to the record needs the
     * difference visible rather than normalised away.
     */
    nameOnCertificate: text('name_on_certificate').notNull(),
    courseName: text('course_name').notNull(),
    /** Minutes, though the form asks for hours — one unit in the database. */
    courseMinutes: integer('course_minutes').notNull(),
    authorizedBody: text('authorized_body').notNull(),

    /** Relative to `UPLOAD_STORAGE_PATH`. Never a URL, never client-supplied. */
    filePath: text('file_path').notNull(),
    fileName: text('file_name').notNull(),
    fileMime: text('file_mime').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),

    /** One of `EXTERNAL_CERT_STATUSES`. */
    status: text('status').notNull().default('pending_manager'),

    /** Who it was sent to at submission time — null when there was no
     *  manager and it went straight to L&D. */
    managerUserId: integer('manager_user_id'),
    managerDecidedBy: integer('manager_decided_by'),
    managerDecidedAt: timestamp('manager_decided_at', {
      mode: 'string',
      withTimezone: true,
    }),
    managerNote: text('manager_note'),

    adminDecidedBy: integer('admin_decided_by'),
    adminDecidedAt: timestamp('admin_decided_at', {
      mode: 'string',
      withTimezone: true,
    }),
    adminNote: text('admin_note'),

    /** The companion course an approval created, if it has been approved. */
    courseId: integer('course_id'),

    createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_external_certs_user').on(table.userId, table.createdAt),
    index('idx_external_certs_org_status').on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
  ],
);
