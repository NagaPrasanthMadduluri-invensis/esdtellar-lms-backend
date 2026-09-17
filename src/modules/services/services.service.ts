import { Injectable, NotFoundException } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { REQUEST_STATUSES } from '@/common/edstellar-services';
import { ActivityService } from '@/modules/activity/activity.service';

import { ServicesRepository } from './services.repository';
import type {
  CreateServiceRequestDto,
  RespondToRequestDto,
} from './dto/service-request.dto';

const DEFAULT_LIMIT = 50;

@Injectable()
export class ServicesService {
  constructor(
    private readonly repository: ServicesRepository,
    private readonly activity: ActivityService,
  ) {}

  /**
   * This organization's requests, plus a count per status for the KPI tiles.
   *
   * The tiles are reduced from ONE grouped query rather than four `COUNT(*)`s
   * beside the list, so they cannot disagree with each other — the same rule
   * the Manage Users directory follows (§10.12).
   */
  async list(scope: OrgScope, limit = DEFAULT_LIMIT, offset = 0) {
    const [requests, counts] = await Promise.all([
      this.repository.list(scope, limit, offset),
      this.repository.counts(scope),
    ]);

    const byStatus = Object.fromEntries(
      REQUEST_STATUSES.map((s) => [s, 0]),
    ) as Record<string, number>;
    let total = 0;
    for (const row of counts) {
      byStatus[row.status] = Number(row.n);
      total += Number(row.n);
    }

    return { requests, counts: { ...byStatus, total } };
  }

  async get(scope: OrgScope, id: number) {
    const request = await this.repository.findById(scope, id);
    if (!request) throw new NotFoundException('Service request not found');
    return { request: this.shape(request) };
  }

  /* ── Platform (super-admin) ───────────────────────────────────────────
     Behind `@PlatformAdmin()`. These are the only methods in this service
     that cross tenants, and the only writer of a request's status. */

  async listForPlatform(query: {
    status?: string;
    organization_id?: number;
    limit?: number;
    offset?: number;
  }) {
    const [requests, counts] = await Promise.all([
      this.repository.listAllForPlatform({
        status: query.status,
        organizationId: query.organization_id,
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
      }),
      this.repository.platformCounts(),
    ]);

    const byStatus = Object.fromEntries(
      REQUEST_STATUSES.map((s) => [s, 0]),
    ) as Record<string, number>;
    let total = 0;
    for (const row of counts) {
      byStatus[row.status] = Number(row.n);
      total += Number(row.n);
    }

    return { requests, counts: { ...byStatus, total } };
  }

  async getForPlatform(id: number) {
    const row = await this.repository.findByIdForPlatform(id);
    if (!row) throw new NotFoundException('Service request not found');
    /**
     * NOT passed through `shape()`.
     *
     * `findByIdForPlatform` is raw SQL (`SELECT sr.*`), so it is ALREADY
     * snake_case, while `shape()` exists to convert a Drizzle row FROM
     * camelCase. Running it over this row read `row.refNo` off something that
     * only has `ref_no` and returned undefined for half the dialog — the
     * fifth time this repository's mixed Drizzle/raw-SQL reads have caught
     * somebody out. If a method uses raw SQL, its result needs no shaping.
     */
    return { request: row };
  }

  /** Move it along and write the reply the tenant will see. */
  async respond(id: number, dto: RespondToRequestDto) {
    const existing = await this.repository.findByIdForPlatform(id);
    if (!existing) throw new NotFoundException('Service request not found');

    const updated = await this.repository.respond(id, {
      status: dto.status,
      responseNote: dto.response_note ?? null,
    });
    if (!updated) throw new NotFoundException('Service request not found');
    // `respond` IS a Drizzle `.returning()`, so this one does need shaping.
    return { request: this.shape(updated) };
  }

    /**
   * snake_case, like every other response (§8.1).
   *
   * `findById` and `create` are Drizzle `.select()`/`.returning()` calls, so
   * they hand back the TypeScript camelCase names while `list()` — which names
   * its columns — is snake_case. Handing both out as they came is the §10.10
   * defect, and it has now been found three times in this codebase: a caller
   * reads `request.ref_no`, gets `undefined`, and renders a blank cell that
   * looks like missing data rather than a mismatched key.
   */
  private shape(row: {
    id: number;
    refNo: string;
    service: string;
    answers: unknown;
    timeline: string | null;
    budget: string | null;
    status: string;
    responseNote: string | null;
    contactName: string;
    contactEmail: string;
    createdAt: string;
    updatedAt: string;
  }) {
    return {
      id: row.id,
      ref_no: row.refNo,
      service: row.service,
      answers: row.answers,
      timeline: row.timeline,
      budget: row.budget,
      status: row.status,
      response_note: row.responseNote,
      contact_name: row.contactName,
      contact_email: row.contactEmail,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  /**
   * File a request.
   *
   * Everything identifying is taken from the VERIFIED TOKEN, never the body:
   * the organization, the user id, and the name and email the request is
   * signed with. A body carrying its own `contact_email` would let an admin
   * file a request in a colleague's name — and this is the one feature whose
   * output leaves the building, so the name on it has to be the real one
   * (§5.3).
   */
  async create(
    scope: OrgScope,
    actor: AuthenticatedUser,
    dto: CreateServiceRequestDto,
  ) {
    const refNo = await this.repository.nextRefNo(scope, new Date().getFullYear());

    const request = await this.repository.create(scope, {
      refNo,
      service: dto.service,
      answers: dto.answers ?? {},
      timeline: dto.timeline ?? null,
      budget: dto.budget ?? null,
      requestedBy: actor.userId,
      contactName: `${actor.firstName ?? ''} ${actor.lastName ?? ''}`.trim() || actor.email,
      contactEmail: actor.email,
    });

    // Best-effort (§8.4) — a feed entry must never fail the request itself.
    void this.activity.record(scope, {
      type: 'service_requested',
      detail: `${dto.service} (${refNo})`,
      actor,
      subjectType: 'service_request',
      subjectId: request.id,
    });

    return { request: this.shape(request) };
  }
}
