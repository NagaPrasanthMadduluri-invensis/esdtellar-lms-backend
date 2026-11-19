import {
  date,
  integer,
  pgTable,
  serial,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

import { organizations } from './organizations.schema';
import { users } from './users.schema';

/**
 * Daily engagement accumulator (0072). Engagement = ACTIVE time (cursor/keyboard
 * moving; idle over 5 minutes excluded), posted in short batches by the client
 * and summed here. ACTIVITY (`orgScope`). A NEW metric beside §10.4 learning
 * hours, which are unchanged.
 */
export const engagementDaily = pgTable(
  'engagement_daily',
  {
    id: serial('id').primaryKey(),
    organizationId: integer('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    activeSeconds: integer('active_seconds').notNull().default(0),
    updatedAt: timestamp('updated_at', { mode: 'string', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('engagement_daily_user_day_key').on(table.userId, table.day),
    index('idx_engagement_daily_org_day').on(table.organizationId, table.day),
  ],
);
