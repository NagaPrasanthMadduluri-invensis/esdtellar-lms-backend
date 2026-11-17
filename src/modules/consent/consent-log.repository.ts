import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

export interface ConsentEventInput {
  userId: number;
  event: string;
  noticeVersion?: string | null;
  details?: Record<string, unknown> | null;
  source?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ConsentEventRow {
  id: number;
  event: string;
  notice_version: string | null;
  details: Record<string, unknown> | null;
  source: string | null;
  ip_address: string | null;
  created_at: string;
}

/**
 * The consent log (0065). Append-only: there is an insert and a read, and no
 * update or delete. The retention sweep's PII scrub lives in RetentionRepository
 * with the rest of that sweep.
 */
@Injectable()
export class ConsentLogRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * One row. The organization is read from the user row in the same statement,
   * so a caller that has only a user id (the public unsubscribe link) can log
   * without a second lookup, and no caller can name another tenant.
   */
  async insert(input: ConsentEventInput): Promise<void> {
    await this.db.run(sql`
      INSERT INTO consent_events
        (organization_id, user_id, event, notice_version, details, source, ip_address, user_agent)
      SELECT u.organization_id, u.id, ${input.event}, ${input.noticeVersion ?? null},
             ${input.details ? JSON.stringify(input.details) : null}::jsonb,
             ${input.source ?? null}, ${input.ipAddress ?? null}, ${input.userAgent ?? null}
        FROM users u
       WHERE u.id = ${input.userId}
    `);
  }

  /** The person's own history, newest first. `user_agent` is not returned. */
  async listForUser(userId: number, limit = 100): Promise<ConsentEventRow[]> {
    return this.db.all<ConsentEventRow>(sql`
      SELECT id, event, notice_version, details, source, ip_address, created_at
        FROM consent_events
       WHERE user_id = ${userId}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit}
    `);
  }
}
