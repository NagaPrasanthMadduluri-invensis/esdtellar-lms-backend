import {
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { notifications } from './notifications.schema';
import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * The email outbox — the message store, and the reason there is no broker.
 *
 * `notify()` writing a bell row and publishing a job to a queue are two
 * systems, and the transaction can commit on one and not the other in either
 * direction. A row in the same database cannot have that problem. pg-boss
 * runs on top as the scheduler and the single-consumer lock; it does not
 * carry the messages. The full argument is in `0037_email_outbox.sql`.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * Forensics only, and nullable on purpose. A NOT NULL reference would
     * tie the two inserts into one transaction, so an email failure would
     * roll back the bell — and a password reset has no bell at all.
     */
    notificationId: integer('notification_id').references(
      () => notifications.id,
      { onDelete: 'set null' },
    ),
    /** A catalogue key, or a direct type such as `password_reset`. */
    type: text('type').notNull(),
    /** Frozen: a row is sent under the rules it was accepted under. */
    policy: text('policy').notNull(),
    /** Frozen at enqueue — see the migration on why this is not a join. */
    toEmail: text('to_email').notNull(),
    toName: text('to_name'),
    orgName: text('org_name'),
    subject: text('subject').notNull(),
    body: text('body'),
    /** Relative. Made absolute against CLIENT_ORIGIN at render time. */
    link: text('link'),
    actorName: text('actor_name'),
    dedupeKey: text('dedupe_key').notNull(),
    /** pending | sending | sent | failed | suppressed */
    status: text('status').notNull().default('pending'),
    /** Incremented AT CLAIM, so a row that kills the worker eventually stops. */
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** SES MessageId — the only key an SNS bounce event can be matched on. */
    providerMessageId: text('provider_message_id'),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_email_outbox_dedupe').on(table.dedupeKey),
    // The partial WHERE clauses are declared in the migration — Drizzle has
    // no expression for them, and the migration is what executes (§6.3).
    index('idx_email_outbox_claimable').on(table.nextAttemptAt, table.id),
    index('idx_email_outbox_stuck').on(table.claimedAt),
    index('idx_email_outbox_daily').on(table.sentAt),
    index('idx_email_outbox_user').on(table.userId, table.enqueuedAt),
    index('idx_email_outbox_provider_msg').on(table.providerMessageId),
  ],
);

/**
 * Addresses we must never send to again.
 *
 * No organization and no user: a hard bounce is a fact about an ADDRESS. It
 * outranks every preference and every org setting, transactional included,
 * because the sending reputation it protects is shared by every tenant.
 */
export const emailSuppressions = pgTable('email_suppressions', {
  email: text('email').primaryKey(),
  /** hard_bounce | complaint | manual */
  reason: text('reason').notNull(),
  detail: text('detail'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Three levers, not a 100-cell matrix. An ABSENT ROW means everything on,
 * which is what makes this migration backfill-free.
 */
export const userEmailPreferences = pgTable('user_email_preferences', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Honoured for everything, transactional included. See the migration. */
  allOff: integer('all_off').notNull().default(0),
  /** Comma-delimited catalogue `group` keys. Announcements only. */
  groupsOff: text('groups_off').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Password reset. Hashes, never tokens — this table is as readable as any
 * other, and a plaintext token in it is a standing takeover primitive for
 * every row. Same reasoning as `users.password`.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set rather than deleted, so "already used" is a distinct answer. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_password_reset_token_hash').on(table.tokenHash),
    index('idx_password_reset_user').on(table.userId, table.createdAt),
  ],
);
