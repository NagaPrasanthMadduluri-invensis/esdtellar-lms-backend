import { Injectable, Logger } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { activityGroup, activityLabel, type ActivityType } from '@/common/activity';

import { ActivityRepository, type NewActivity } from './activity.repository';

/** What a caller passes to `record()`. `title` comes from the catalogue. */
export interface RecordActivityInput {
  type: ActivityType;
  detail?: string | null;
  actor: { userId: number; firstName?: string; lastName?: string } | null;
  subjectType?: string | null;
  subjectId?: number | null;
  /** Overrides the catalogue label. Use sparingly — the label is the point. */
  title?: string;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly repository: ActivityRepository) {}

  /**
   * Record one or more entries. **Never throws** (§8.4).
   *
   * This is the whole contract. Recording that a course was published is
   * secondary to publishing it, and a dashboard panel must not be able to fail
   * a write the admin actually asked for. Every caller is therefore free to
   * `void this.activity.record(...)` without a try/catch of its own, and every
   * caller does.
   *
   * The cost is stated plainly in the schema docblock: the entries that are
   * missing are the ones whose write failed, so this table is not evidence.
   */
  async record(
    scope: OrgScope,
    input: RecordActivityInput | RecordActivityInput[],
  ): Promise<void> {
    const inputs = Array.isArray(input) ? input : [input];
    if (inputs.length === 0) return;
    try {
      const entries: NewActivity[] = inputs.map((i) => ({
        type: i.type,
        title: i.title ?? activityLabel(i.type),
        detail: i.detail ?? null,
        actorUserId: i.actor?.userId ?? null,
        actorName: this.nameOf(i.actor),
        subjectType: i.subjectType ?? null,
        subjectId: i.subjectId ?? null,
      }));
      await this.repository.record(scope, entries);
    } catch (error) {
      this.logger.warn(
        `Activity not recorded (${inputs.map((i) => i.type).join(', ')}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Newest first, paginated. Shapes the row for the dashboard panel. */
  async list(scope: OrgScope, limit = 8, offset = 0) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const [rows, total] = await Promise.all([
      this.repository.list(scope, safeLimit, Math.max(offset, 0)),
      this.repository.count(scope),
    ]);
    return {
      activity: rows.map((r) => ({
        id: r.id,
        type: r.type,
        group: activityGroup(r.type),
        title: r.title,
        detail: r.detail,
        actor_name: r.actor_name,
        subject_type: r.subject_type,
        subject_id: r.subject_id,
        created_at: r.created_at,
      })),
      total,
    };
  }

  private nameOf(
    actor: RecordActivityInput['actor'],
  ): string {
    if (!actor) return 'System';
    const name = `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim();
    return name || 'Administrator';
  }
}
