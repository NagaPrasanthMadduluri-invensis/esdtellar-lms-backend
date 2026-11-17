import { Injectable } from '@nestjs/common';

import { CURRENT_PRIVACY_VERSION, type ConsentEvent } from '@/common/consent';

import { ConsentLogRepository } from './consent-log.repository';

/** Who clicked: read from the HTTP request by the controller, never the body. */
export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Build a RequestMeta in a CONTROLLER (services never see the request, §3).
 * The IP rule is the audit middleware's: first X-Forwarded-For hop (nginx and
 * Cloudflare sit in front), else the socket address.
 */
export function requestMeta(request: {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}): RequestMeta {
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ua = request.headers['user-agent'];
  return {
    ip: (first?.split(',')[0].trim() || request.ip) ?? null,
    userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? null,
  };
}

/**
 * The consent log (0065): one place every module writes to when a person
 * acknowledges the notice, changes an optional choice, or asks to withdraw.
 *
 * `record()` AWAITS and THROWS, unlike the activity log (§8.4). This table is
 * the proof, and an acknowledgement that cannot be recorded must not be
 * reported as recorded. Callers logging a side-effect of another write
 * (a choice changed through the profile) still await it, after that write.
 */
@Injectable()
export class ConsentLogService {
  constructor(private readonly repository: ConsentLogRepository) {}

  async record(input: {
    userId: number;
    event: ConsentEvent;
    details?: Record<string, unknown> | null;
    source: string;
    meta?: RequestMeta;
    noticeVersion?: string | null;
  }): Promise<void> {
    await this.repository.insert({
      userId: input.userId,
      event: input.event,
      noticeVersion:
        input.noticeVersion === undefined
          ? CURRENT_PRIVACY_VERSION
          : input.noticeVersion,
      details: input.details ?? null,
      source: input.source,
      ipAddress: input.meta?.ip ? String(input.meta.ip).slice(0, 100) : null,
      userAgent: input.meta?.userAgent
        ? String(input.meta.userAgent).slice(0, 400)
        : null,
    });
  }

  /** The person's own history, newest first. */
  async history(userId: number) {
    const rows = await this.repository.listForUser(userId);
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      notice_version: r.notice_version,
      details: r.details,
      source: r.source,
      ip_address: r.ip_address,
      created_at: r.created_at,
    }));
  }
}
