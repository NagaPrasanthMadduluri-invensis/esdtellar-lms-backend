import { Injectable, Logger } from '@nestjs/common';

import { AuditRepository, type AuditFilters, type NewAuditEntry } from './audit.repository';

/** Everything the page may narrow by. All optional. */
export interface AuditQuery {
  actor_user_id?: number;
  actor_portal?: string;
  action?: string;
  entity?: string;
  outcome?: string;
  from?: string;
  to?: string;
  q?: string;
  organization_id?: number;
  limit?: number;
  offset?: number;
}

const MAX_PAGE = 100;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly repository: AuditRepository) {}

  /**
   * Write one entry. Retried ONCE, and a final failure is logged at `error`.
   *
   * The contract is deliberately NOT `ActivityService.record()`'s. That one
   * never throws and logs at `warn`, because a dashboard panel must not be
   * able to fail a write the admin asked for. This one is the accountability
   * record, so losing a row is a real defect and should look like one in the
   * logs — but it still does not propagate, because the alternative is that
   * an audit-table outage takes the whole application down, and refusing to
   * let anybody do anything is a worse answer than a gap somebody can see in
   * the error log.
   */
  async record(entry: NewAuditEntry): Promise<void> {
    try {
      await this.repository.record(entry);
      return;
    } catch (first) {
      try {
        await this.repository.record(entry);
        return;
      } catch (second) {
        this.logger.error(
          `AUDIT ROW LOST — ${entry.method} ${entry.path} by ${entry.actorName}: ${
            second instanceof Error ? second.message : String(second)
          } (first attempt: ${first instanceof Error ? first.message : String(first)})`,
        );
      }
    }
  }

  /**
   * One page, its totals, and nothing else.
   *
   * `organizationId` is a PARAMETER of this method and never read from the
   * query, so the two controllers decide the scope and the caller cannot.
   * The tenant controller passes its own scope; the platform controller
   * passes null for everything, or one org when the reader picks one.
   */
  async list(organizationId: number | null, query: AuditQuery) {
    const filters: AuditFilters = {
      organizationId:
        organizationId === null && query.organization_id
          ? Number(query.organization_id)
          : organizationId,
      actorUserId: query.actor_user_id ? Number(query.actor_user_id) : null,
      actorPortal: query.actor_portal ?? null,
      action: query.action ?? null,
      entity: query.entity ?? null,
      outcome: query.outcome ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
      q: query.q?.trim() || null,
      limit: Math.min(Math.max(Number(query.limit) || 50, 1), MAX_PAGE),
      offset: Math.max(Number(query.offset) || 0, 0),
    };

    const [rows, total, summary] = await Promise.all([
      this.repository.list(filters),
      this.repository.count(filters),
      this.repository.summary(filters),
    ]);

    return {
      entries: rows.map((r) => this.shape(r)),
      total,
      summary,
      has_more: filters.offset + rows.length < total,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async options(organizationId: number | null) {
    return this.repository.options(organizationId);
  }

  /**
   * A Postgres timestamp has a space and a `+00` that `new Date()` rejects —
   * §10.24 records a whole column of em-dashes on a screen that was being
   * sent real dates. Converted once, here, so the browser needs no patching.
   */
  private shape(r: Record<string, unknown>) {
    const created = r.created_at;
    return {
      ...r,
      created_at:
        created instanceof Date
          ? created.toISOString()
          : created
            ? new Date(String(created).replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString()
            : null,
    };
  }
}
