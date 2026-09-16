import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { activityLog } from '@/database/schema';
import { orgScope, type OrgScope } from '@/database/org-scope';

export interface ActivityRow {
  id: number;
  type: string;
  title: string;
  detail: string | null;
  actor_name: string;
  subject_type: string | null;
  subject_id: number | null;
  created_at: string;
}

export interface NewActivity {
  type: string;
  title: string;
  detail?: string | null;
  actorUserId?: number | null;
  actorName: string;
  subjectType?: string | null;
  subjectId?: number | null;
}

@Injectable()
export class ActivityRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * One multi-row INSERT, never one per entry (§7.1). Callers that record a
   * bulk action — assigning a course to 15 learners — write ONE row describing
   * the action, not fifteen; but a caller doing several distinct things in one
   * request batches them here.
   */
  async record(scope: OrgScope, entries: NewActivity[]): Promise<void> {
    if (entries.length === 0) return;
    await this.database.db.insert(activityLog).values(
      entries.map((e) => ({
        organizationId: scope.organizationId,
        type: e.type,
        title: e.title,
        detail: e.detail ?? null,
        actorUserId: e.actorUserId ?? null,
        actorName: e.actorName,
        subjectType: e.subjectType ?? null,
        subjectId: e.subjectId ?? null,
      })),
    );
  }

  /**
   * Newest first, within one organization. `orgScope`, never `contentScope`:
   * an activity row records what somebody in THIS org did (see the schema
   * docblock).
   *
   * Paginated (§7.6) — the table grows with every admin action and is the
   * kind of list that is fine for a year and then is not.
   */
  async list(
    scope: OrgScope,
    limit: number,
    offset: number,
  ): Promise<ActivityRow[]> {
    const rows = await this.database.db
      .select({
        id: activityLog.id,
        type: activityLog.type,
        title: activityLog.title,
        detail: activityLog.detail,
        actor_name: activityLog.actorName,
        subject_type: activityLog.subjectType,
        subject_id: activityLog.subjectId,
        created_at: activityLog.createdAt,
      })
      .from(activityLog)
      .where(orgScope('activity_log', scope))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(limit)
      .offset(offset);
    return rows as ActivityRow[];
  }

  async count(scope: OrgScope): Promise<number> {
    const [row] = await this.database.db
      .select({ n: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(orgScope('activity_log', scope));
    return Number(row?.n ?? 0);
  }
}
