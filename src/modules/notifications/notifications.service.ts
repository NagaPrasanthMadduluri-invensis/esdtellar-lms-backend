import { Injectable, Logger } from '@nestjs/common';

import {
  NOTIFICATION_TYPES,
  UNREAD_BADGE_CAP,
  notificationLabel,
  type NotificationType,
} from '@/common/notifications';

import {
  NotificationsRepository,
  type NewNotification,
} from './notifications.repository';

/** What a caller passes to `notify()`. */
export interface NotifyInput {
  /** Who receives it. Duplicates are collapsed. */
  userIds: number[];
  organizationId: number;
  type: NotificationType;
  title?: string;
  body?: string | null;
  link?: string | null;
  subjectType?: string | null;
  subjectId?: number | null;
  actorName?: string | null;
  /**
   * Do not notify this person even if they are in `userIds`.
   *
   * Almost always the actor: an admin who assigns a course does not need
   * telling that they assigned a course, and a bell that lights up at your
   * own actions is one people learn to ignore.
   */
  exceptUserId?: number | null;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly repository: NotificationsRepository) {}

  /**
   * Send a notification to one or many people. **Never throws** (§8.4).
   *
   * Identical contract to `ActivityService.record()`, and for the same
   * reason: telling somebody about a thing is secondary to the thing. A
   * learner's course assignment must not fail because a notification row
   * did not write, so every caller is free to `void this.notifications.notify(...)`
   * and every caller does.
   *
   * The cost is the same too, and worth stating: the notifications that are
   * missing are precisely the ones whose write failed. This is a product
   * feature, not a delivery guarantee. Nothing here should be the only way a
   * person learns something that matters — the data is on their screens
   * regardless, and the bell is a prompt to look.
   */
  async notify(input: NotifyInput): Promise<void> {
    try {
      const recipients = [...new Set(input.userIds)].filter(
        (id) => Number.isInteger(id) && id > 0 && id !== input.exceptUserId,
      );
      if (recipients.length === 0) return;

      const entries: NewNotification[] = recipients.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        type: input.type,
        title: input.title ?? notificationLabel(input.type),
        body: input.body ?? null,
        link: input.link ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        actorName: input.actorName ?? null,
      }));

      await this.repository.insert(entries);
    } catch (error) {
      this.logger.warn(
        `Notification not sent (${input.type}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Send only if this person has not had the same notification recently.
   *
   * For anything derived from a RECOMPUTED state rather than a discrete
   * event — see the repository's note on why a leaderboard rank needs this
   * and a badge does not.
   */
  async notifyOnce(
    input: NotifyInput & { withinDays?: number },
  ): Promise<void> {
    try {
      const [userId] = [...new Set(input.userIds)];
      if (!userId || userId === input.exceptUserId) return;
      const seen = await this.repository.existsRecent({
        userId,
        type: input.type,
        subjectId: input.subjectId ?? null,
        withinDays: input.withinDays ?? 7,
      });
      if (seen) return;
      await this.notify(input);
    } catch (error) {
      this.logger.warn(
        `Notification not sent (${input.type}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Every active admin of an organization — the usual fan-out target. */
  async adminsOf(organizationId: number): Promise<number[]> {
    try {
      return await this.repository.adminRecipients(organizationId);
    } catch {
      return [];
    }
  }

  /**
   * Edstellar's own staff, with the platform org id to file the rows under.
   *
   * A platform admin's notification carries the PLATFORM org, not the tenant
   * that caused it — the row belongs to the person receiving it, and filing
   * it under someone else's tenant would put Edstellar's own bell inside a
   * customer's org scope.
   */
  async platformAdmins(): Promise<{
    organizationId: number | null;
    userIds: number[];
  }> {
    try {
      return await this.repository.platformRecipients();
    } catch {
      return { organizationId: null, userIds: [] };
    }
  }

  /**
   * Notify Edstellar's staff in one call, since every caller does the same
   * two steps and the org id is easy to get wrong.
   */
  async notifyPlatform(
    input: Omit<NotifyInput, 'userIds' | 'organizationId'>,
  ): Promise<void> {
    const { organizationId, userIds } = await this.platformAdmins();
    if (organizationId === null || userIds.length === 0) return;
    await this.notify({ ...input, userIds, organizationId });
  }

  /** Everyone on a session's roster. */
  async sessionRoster(sessionId: number): Promise<number[]> {
    try {
      return await this.repository.sessionRosterRecipients(sessionId);
    } catch {
      return [];
    }
  }

  /* ── Reads, for the bell ── */

  async list(userId: number, limit = 20, offset = 0) {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const safeOffset = Math.max(offset, 0);

    const [rows, unread, total] = await Promise.all([
      this.repository.list(userId, safeLimit, safeOffset),
      this.repository.unreadCount(userId),
      this.repository.total(userId),
    ]);

    return {
      notifications: rows.map((r) => ({
        ...r,
        /** Derived, never stored — `read_at IS NULL` is the single truth. */
        is_read: r.read_at !== null,
        // The icon and group come from the catalogue rather than the row, so a
        // copy or icon change applies to history too. The TITLE does not:
        // that names things that may since have been renamed (§0030).
        icon: NOTIFICATION_TYPES[r.type as NotificationType]?.icon ?? 'Bell',
        group: NOTIFICATION_TYPES[r.type as NotificationType]?.group ?? 'learning',
      })),
      unread_count: unread,
      /** What the badge prints. Past the cap it reads "9+". */
      badge: unread > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(unread),
      total,
      has_more: safeOffset + rows.length < total,
    };
  }

  async markAllRead(userId: number) {
    const marked = await this.repository.markAllRead(userId);
    return { marked, unread_count: 0 };
  }

  async markRead(userId: number, id: number) {
    await this.repository.markRead(userId, id);
    return { unread_count: await this.repository.unreadCount(userId) };
  }
}
