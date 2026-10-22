import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

import { users } from './users.schema';

/** One stored recovery code: a SHA-256 hash and whether it has been spent. */
export interface RecoveryCode {
  hash: string;
  used_at: string | null;
}

/**
 * Admin MFA enrolment (0058). One row per user who has set up TOTP.
 *
 * `secret` is the TOTP shared secret ENCRYPTED with AES-256-GCM (see the
 * migration header and common/crypto/secret-box.util.ts) — never plaintext.
 *
 * `enabledAt` NULL = a pending enrolment (secret stored, not yet proven), so
 * login does not challenge. Set the moment a first code verifies, and only then
 * do the recovery codes exist and login require the second factor.
 */
export const userMfa = pgTable('user_mfa', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  enabledAt: timestamp('enabled_at', { mode: 'string', withTimezone: true }),
  recoveryCodes: jsonb('recovery_codes')
    .$type<RecoveryCode[]>()
    .notNull()
    .default([]),
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type UserMfaRow = typeof userMfa.$inferSelect;
