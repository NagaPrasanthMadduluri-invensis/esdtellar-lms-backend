import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { SharedFileService } from '@/modules/files/shared-file.service';

import { MessagesRepository, type MessageRow } from './messages.repository';

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
    private readonly files: SharedFileService,
  ) {}

  /** The attachment shape a bubble renders, or null. `file_path` never leaves
   *  the server — the client fetches the file by the message id. */
  private attachmentOf(m: MessageRow) {
    return m.file_name
      ? { name: m.file_name, mime: m.file_mime ?? null, size: m.file_size ?? null }
      : null;
  }

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
          // An attachment-only message previews as its file name.
          body: r.last_body || r.last_file_name || "",
          has_attachment: !!r.last_file_name,
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
        attachment: this.attachmentOf(m),
      })),
    };
  }

  async send(
    scope: OrgScope,
    user: AuthenticatedUser,
    otherId: number,
    body: string,
    file?: Express.Multer.File,
  ) {
    if (otherId === user.userId) {
      throw new BadRequestException('You cannot message yourself');
    }
    const text = (body ?? '').trim();
    if (!text && !file) {
      throw new BadRequestException('Type a message or attach a file');
    }
    const other = await this.repository.findActiveUser(scope, otherId);
    if (!other) throw new NotFoundException('Person not found');

    // Store the file first; if the insert then fails, discard it (§10.26).
    const stored = file ? await this.files.store(file) : null;
    let created: MessageRow;
    try {
      created = await this.repository.insert(scope, {
        senderId: user.userId,
        recipientId: otherId,
        body: text,
        filePath: stored?.path ?? null,
        fileName: stored?.name ?? null,
        fileMime: stored?.mime ?? null,
        fileSize: stored?.size ?? null,
      });
    } catch (error) {
      await this.files.discard(stored?.path);
      throw error;
    }

    const fromName = shortName(user.firstName, user.lastName);
    const preview = text || (stored ? `Shared a file: ${stored.name}` : '');
    // Bell only (email: 'none' in the catalogue) — a DM is read on the Messages
    // page, and emailing every line would flood an inbox. The link opens the
    // thread with the sender.
    void this.notifications.notify({
      userIds: [otherId],
      organizationId: scope.organizationId,
      type: 'direct_message',
      title: `New message from ${fromName}`,
      body: preview.length > 90 ? `${preview.slice(0, 90)}…` : preview,
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
        attachment: this.attachmentOf(created),
      },
    };
  }

  /** Stream a message's attachment — only its sender or recipient may read it. */
  async messageFile(scope: OrgScope, user: AuthenticatedUser, messageId: number) {
    const row = await this.repository.findMessageFile(scope, messageId);
    if (!row || !row.file_path) throw new NotFoundException('File not found');
    if (row.sender_id !== user.userId && row.recipient_id !== user.userId) {
      throw new ForbiddenException('This attachment is not yours to view');
    }
    return {
      stream: this.files.open(row.file_path),
      fileName: row.file_name ?? 'file',
      mime: row.file_mime ?? 'application/octet-stream',
    };
  }

  async unread(scope: OrgScope, userId: number) {
    return { count: await this.repository.unreadCount(scope, userId) };
  }
}
