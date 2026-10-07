import {
  bigserial, index, integer, jsonb, pgTable, text, timestamp,
} from 'drizzle-orm/pg-core';

import { users } from './users.schema';

/**
 * Mirrors `audit_log`, added by `0043_audit_log.sql`. Read that file's header
 * first — it carries the argument. The short version:
 *
 * **This is NOT `activity_log`, and the difference is who writes it.**
 * `activity_log` holds 21 curated types written BY HAND where a service has
 * something a human wants to read, best-effort, feeding the dashboard panel.
 * This holds EVERY mutating request, written by one global interceptor,
 * succeeded or refused.
 *
 * Completeness is the whole point, and it is why the writer is an
 * interceptor rather than 200 call sites: §5.2.1's rule — a permission with
 * no guard behind it is a screen that lies — has an exact analogue here, and
 * it is worse, because a missing audit row is invisible. An endpoint written
 * next year is covered the day it is written, with nobody remembering
 * anything.
 *
 * **What it does not promise.** The row is written after the handler
 * returns, not inside its transaction, so a crash in that gap loses it. Far
 * narrower than best-effort, and not the same as guaranteed.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    /**
     * NULLABLE on purpose: a platform admin acting outside any tenant, and a
     * request refused before its token verified, both belong to no
     * organization. Writing 0 or the platform org there would invent a fact.
     */
    organizationId: integer('organization_id'),

    /** ON DELETE SET NULL — deleting the account must not erase the record. */
    actorUserId: integer('actor_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Denormalised and frozen at write time, the same reasoning as
     * `activity_log.actor_name` and `email_outbox.to_email`: a join renames
     * history when somebody corrects their name, and returns nothing once
     * the account is gone — which is exactly the row this table exists to
     * still have.
     */
    actorName: text('actor_name').notNull(),
    actorEmail: text('actor_email'),
    /** admin | learner | trainer — what the filter groups by. */
    actorPortal: text('actor_portal'),
    /** The RBAC role's label — what a reader recognises. A Manager rides the
     * learner portal, so the portal alone would file them under "learner". */
    actorRole: text('actor_role'),

    /** Set only inside a support session (§10.17). */
    impersonatorName: text('impersonator_name'),

    method: text('method').notNull(),
    /** The matched pattern, `/api/admin/courses/:id` — what groups. */
    route: text('route').notNull(),
    /** What was actually requested — what identifies. */
    path: text('path').notNull(),
    /** create | update | delete, derived once at write time. */
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: integer('entity_id'),

    statusCode: integer('status_code').notNull(),
    /** success | failure. */
    outcome: text('outcome').notNull(),
    errorMessage: text('error_message'),

    /**
     * The request body, REDACTED and capped. Never raw: three routes carry a
     * password and two more carry a token, and an audit log that stores
     * credentials is a bigger liability than no audit log.
     */
    summary: jsonb('summary'),

    ip: text('ip'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_audit_org_created').on(table.organizationId, table.createdAt),
    index('idx_audit_created').on(table.createdAt),
    index('idx_audit_actor').on(table.actorUserId, table.createdAt),
    index('idx_audit_entity').on(table.entity, table.entityId, table.createdAt),
    // The partial failures index is declared in the migration only — Drizzle
    // has no expression for a WHERE on an index here, and the migration is
    // what executes (§6.3).
  ],
);
