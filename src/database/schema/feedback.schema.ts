import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { organizations } from './organizations.schema';
import { sessions } from './sessions.schema';
import { users } from './users.schema';

/**
 * What a learner thought of a session they attended.
 *
 * `userId` is stored and NO trainer route ever selects it. That asymmetry is
 * the feature: the column exists so one person cannot rate a session twice
 * and so an admin can attribute an abusive comment, while the trainer sees
 * ratings and text with no names. The full argument is in
 * `0032_session_feedback.sql`.
 *
 * Three ratings rather than one average, because content, trainer and
 * delivery fail separately and two of the three are not the trainer's to fix.
 */
export const sessionFeedback = pgTable(
  'session_feedback',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The author. Admin routes read it; trainer routes must not. */
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ratingContent: integer('rating_content').notNull(),
    ratingTrainer: integer('rating_trainer').notNull(),
    ratingDelivery: integer('rating_delivery').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /** One person, one opinion per session. */
    unique('session_feedback_session_id_user_id_key').on(
      table.sessionId,
      table.userId,
    ),
    index('idx_session_feedback_session').on(table.sessionId),
    index('idx_session_feedback_user').on(table.userId),
    index('idx_session_feedback_org_created').on(
      table.organizationId,
      table.createdAt,
    ),
    // A rating outside the scale poisons every average computed over it, so
    // the constraint is in the database as well as the DTO.
    check('rating_content_range', sql`rating_content BETWEEN 1 AND 5`),
    check('rating_trainer_range', sql`rating_trainer BETWEEN 1 AND 5`),
    check('rating_delivery_range', sql`rating_delivery BETWEEN 1 AND 5`),
  ],
);
