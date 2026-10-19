import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import { MessagesRepository } from './messages.repository';

const CONVERSATION_LIMIT = 50;
const THREAD_LIMIT = 200;

/** Someone seen within this window reads as "Available"; else "Active … ago". */
const PRESENCE_ONLINE_MS = 5 * 60 * 1000;

/** First name + last initial — the §10.24 relaxation, used on every surface. */
function shortName(first: string, last: string) {
  return `${first ?? ''}${last ? ` ${last.charAt(0)}.` : ''}`.trim();
}

/** Presence from last-seen (0055): online within the window, plus the stamp. */
function presenceOf(lastSeenAt: string | null) {
  const online =
    lastSeenAt !== null &&
    Date.now() - new Date(lastSeenAt).getTime() < PRESENCE_ONLINE_MS;
  return { online, last_seen: lastSeenAt };
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly repository: MessagesRepository,
    /** Best-effort (§8.4) — a failed bell must not fail the send. */
    private readonly notifications: NotificationsService,
  ) {}

  async conversations(scope: OrgScope, userId: number) {
    const rows = await this.repository.conversations(scope, userId, CONVERSATION_LIMIT);
    return {
      conversations: rows.map((r) => ({
        user_id: Number(r.other_id),
        name: shortName(r.first_name, r.last_name),
        avatar_url: r.avatar_url ?? null,
        ...presenceOf(r.last_seen_at),
        unread: Number(r.unread),
        last_message: {
          body: r.last_body,
          at: r.last_at,
          from_me: Number(r.last_sender_id) === userId,
        },
      })),
    };
  }

  async thread(scope: OrgScope, user: AuthenticatedUser, otherId: number) {
    const other = await this.repository.findActiveUser(scope, otherId);
    // 404, not 403: "exists in another org" and "does not exist" must look the
    // same, or the id becomes an existence oracle (§5.3).
    if (!other) throw new NotFoundException('Person not found');

    // Opening the thread is what "read" means — clear their messages to me.
    await this.repository.markRead(scope, user.userId, otherId);

    const messages = await this.repository.thread(scope, user.userId, otherId, THREAD_LIMIT);
    return {
      peer: {
        user_id: Number(other.id),
        name: shortName(other.first_name, other.last_name),
        avatar_url: other.avatar_url ?? null,
        ...presenceOf(other.last_seen_at),
      },
      messages: messages.map((m) => ({
        id: Number(m.id),
        body: m.body,
        at: m.created_at,
        from_me: Number(m.sender_id) === user.userId,
        read: m.read_at !== null,
      })),
    };
  }

  async send(scope: OrgScope, user: AuthenticatedUser, otherId: number, body: string) {
    if (otherId === user.userId) {
      throw new BadRequestException('You cannot message yourself');
    }
    const other = await this.repository.findActiveUser(scope, otherId);
    if (!other) throw new NotFoundException('Person not found');

    const created = await this.repository.insert(scope, {
      senderId: user.userId,
      recipientId: otherId,
      body,
    });

    const fromName = shortName(user.firstName, user.lastName);
    // Bell only (email: 'none' in the catalogue) — a DM is read on the Messages
    // page, and emailing every line would flood an inbox. The link opens the
    // thread with the sender.
    void this.notifications.notify({
      userIds: [otherId],
      organizationId: scope.organizationId,
      type: 'direct_message',
      title: `New message from ${fromName}`,
      body: body.length > 90 ? `${body.slice(0, 90)}…` : body,
      link: `/messages?with=${user.userId}`,
      subjectType: 'message',
      subjectId: created.id,
      actorName: fromName,
    });

    return {
      message: {
        id: Number(created.id),
        body: created.body,
        at: created.created_at,
        from_me: true,
        read: false,
      },
    };
  }

  async unread(scope: OrgScope, userId: number) {
    return { count: await this.repository.unreadCount(scope, userId) };
  }
}
