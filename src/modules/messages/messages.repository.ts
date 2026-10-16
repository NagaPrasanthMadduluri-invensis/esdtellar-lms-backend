import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

export interface ConversationRow {
  other_id: number;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  last_body: string;
  last_at: string;
  last_sender_id: number;
  unread: number;
}

export interface MessageRow {
  id: number;
  sender_id: number;
  recipient_id: number;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface OtherUserRow {
  id: number;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
}

@Injectable()
export class MessagesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * The inbox: one row per other person, with the latest message and how many
   * of theirs the caller has not read. Org-scoped, so a conversation never
   * crosses a tenant. A conversation is the pair of ids — derived here with a
   * CASE over which side the caller is on, never a stored row.
   */
  async conversations(scope: OrgScope, userId: number, limit: number) {
    return this.db.all<ConversationRow>(sql`
      SELECT
        k.other_id, o.first_name, o.last_name, o.avatar_url,
        lm.body AS last_body, lm.created_at AS last_at, lm.sender_id AS last_sender_id,
        COALESCE(uc.unread, 0) AS unread
      FROM (
        SELECT DISTINCT
          CASE WHEN dm.sender_id = ${userId} THEN dm.recipient_id ELSE dm.sender_id END AS other_id
        FROM direct_messages dm
        WHERE ${orgScope('dm', scope)}
          AND (dm.sender_id = ${userId} OR dm.recipient_id = ${userId})
      ) k
      JOIN users o ON o.id = k.other_id
      JOIN LATERAL (
        SELECT dm.body, dm.created_at, dm.sender_id
        FROM direct_messages dm
        WHERE ${orgScope('dm', scope)}
          AND ((dm.sender_id = ${userId} AND dm.recipient_id = k.other_id)
            OR (dm.sender_id = k.other_id AND dm.recipient_id = ${userId}))
        ORDER BY dm.created_at DESC
        LIMIT 1
      ) lm ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unread
        FROM direct_messages dm
        WHERE ${orgScope('dm', scope)}
          AND dm.recipient_id = ${userId}
          AND dm.sender_id = k.other_id
          AND dm.read_at IS NULL
      ) uc ON true
      ORDER BY lm.created_at DESC
      LIMIT ${limit}
    `);
  }

  /** Every message between the caller and one other person, oldest first. */
  async thread(scope: OrgScope, userId: number, otherId: number, limit: number) {
    return this.db.all<MessageRow>(sql`
      SELECT dm.id, dm.sender_id, dm.recipient_id, dm.body, dm.created_at, dm.read_at
      FROM direct_messages dm
      WHERE ${orgScope('dm', scope)}
        AND ((dm.sender_id = ${userId} AND dm.recipient_id = ${otherId})
          OR (dm.sender_id = ${otherId} AND dm.recipient_id = ${userId}))
      ORDER BY dm.created_at ASC
      LIMIT ${limit}
    `);
  }

  /** Mark every message the OTHER person sent the caller as read. */
  async markRead(scope: OrgScope, userId: number, otherId: number) {
    await this.db.all(sql`
      UPDATE direct_messages dm
      SET read_at = now()
      WHERE ${orgScope('dm', scope)}
        AND dm.recipient_id = ${userId}
        AND dm.sender_id = ${otherId}
        AND dm.read_at IS NULL
    `);
  }

  async insert(
    scope: OrgScope,
    input: { senderId: number; recipientId: number; body: string },
  ): Promise<MessageRow> {
    const rows = await this.db.all<MessageRow>(sql`
      INSERT INTO direct_messages (organization_id, sender_id, recipient_id, body)
      VALUES (${scope.organizationId}, ${input.senderId}, ${input.recipientId}, ${input.body})
      RETURNING id, sender_id, recipient_id, body, created_at, read_at
    `);
    return rows[0];
  }

  async unreadCount(scope: OrgScope, userId: number): Promise<number> {
    const rows = await this.db.all<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM direct_messages dm
      WHERE ${orgScope('dm', scope)}
        AND dm.recipient_id = ${userId}
        AND dm.read_at IS NULL
    `);
    return rows[0]?.count ?? 0;
  }

  /**
   * The other person, looked up org-scoped and active only. Returns null for
   * anyone in another tenant, a deactivated account, or a non-existent id —
   * the service turns that into a 404, so a stranger cannot be messaged and
   * the id cannot be used to probe who exists in another org.
   */
  async findActiveUser(scope: OrgScope, otherId: number): Promise<OtherUserRow | null> {
    const rows = await this.db.all<OtherUserRow>(sql`
      SELECT u.id, u.first_name, u.last_name, u.avatar_url
      FROM users u
      WHERE u.id = ${otherId} AND u.is_active = 1 AND ${orgScope('u', scope)}
    `);
    return rows[0] ?? null;
  }
}
