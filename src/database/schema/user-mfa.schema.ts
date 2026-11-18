import {
  integer,
  jsonb,
  pgTable,
  serial,
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
  /** Encrypted TOTP secret of the ACTIVE method; NULL for the email method (0069). */
  secret: text('secret'),
  /** 'totp' | 'email', the active method once enabled (0069). */
  method: text('method').notNull().default('totp'),
  /** A method being set up, not yet confirmed (0069). */
  pendingMethod: text('pending_method'),
  pendingSecret: text('pending_secret'),
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

/** Emailed sign-in codes, stored only as a keyed hash (0069). */
export const mfaEmailCodes = pgTable('mfa_email_codes', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { mode: 'string', withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { mode: 'string', withTimezone: true }),
  createdAt: timestamp('created_at', { mode: 'string', withTimezone: true })
    .notNull()
    .defaultNow(),
});
