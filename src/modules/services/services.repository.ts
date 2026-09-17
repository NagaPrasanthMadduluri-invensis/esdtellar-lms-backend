import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { serviceRequests } from '@/database/schema';
import { orgScope, type OrgScope } from '@/database/org-scope';

export interface ServiceRequestListRow {
  id: number;
  ref_no: string;
  service: string;
  timeline: string | null;
  budget: string | null;
  status: string;
  response_note: string | null;
  contact_name: string;
  contact_email: string;
  created_at: string;
}

export interface NewServiceRequest {
  refNo: string;
  service: string;
  answers: Record<string, unknown>;
  timeline: string | null;
  budget: string | null;
  requestedBy: number;
  contactName: string;
  contactEmail: string;
}

@Injectable()
export class ServicesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * This organization's requests, newest first.
   *
   * `orgScope`, and there is no content half to this query: a request is
   * activity. The service CATALOGUE is shared by every tenant, but a request
   * against it belongs to exactly one — §10.12's rule, applied before rather
   * than after the leak.
   *
   * `answers` is deliberately NOT selected. The list renders columns, and the
   * questionnaire can run to forty fields of free text that no row on screen
   * shows (§7.3).
   */
  async list(scope: OrgScope, limit: number, offset: number) {
    return this.db
      .select({
        id: serviceRequests.id,
        ref_no: serviceRequests.refNo,
        service: serviceRequests.service,
        timeline: serviceRequests.timeline,
        budget: serviceRequests.budget,
        status: serviceRequests.status,
        response_note: serviceRequests.responseNote,
        contact_name: serviceRequests.contactName,
        contact_email: serviceRequests.contactEmail,
        created_at: serviceRequests.createdAt,
      })
      .from(serviceRequests)
      .where(eq(serviceRequests.organizationId, scope.organizationId))
      .orderBy(desc(serviceRequests.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /** Total in this org, for the pager and the KPI tiles. */
  async counts(scope: OrgScope) {
    const rows = await this.db.all<{ status: string; n: number }>(sql`
      SELECT status, COUNT(*)::int AS n
      FROM service_requests sr
      WHERE ${orgScope('sr', scope)}
      GROUP BY status
    `);
    return rows;
  }

  /** One request with its full questionnaire. */
  async findById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select()
      .from(serviceRequests)
      .where(
        and(
          eq(serviceRequests.id, id),
          eq(serviceRequests.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The next reference number for this organization.
   *
   * Computed in SQL from the highest existing number rather than from
   * `COUNT(*)`: deleting a request must not make the next one reuse a
   * reference somebody has already quoted in an email. The unique index is
   * what actually guarantees it — this only has to be right almost always,
   * and the insert is what fails if two admins submit in the same
   * millisecond.
   */
  async nextRefNo(scope: OrgScope, year: number): Promise<string> {
    const prefix = `REQ-${year}-`;
    const rows = await this.db.all<{ n: number | null }>(sql`
      SELECT MAX(NULLIF(regexp_replace(ref_no, '^.*-', ''), '')::int) AS n
      FROM service_requests sr
      WHERE ${orgScope('sr', scope)} AND sr.ref_no LIKE ${prefix + '%'}
    `);
    const next = Number(rows[0]?.n ?? 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  /* ── Platform (super-admin) ────────────────────────────────────────────
     CROSS-TENANT ON PURPOSE, and the only methods here that are. Every other
     read in this repository is `orgScope`d because a request belongs to one
     tenant; these exist because Edstellar's own staff are the people who
     ACTION them, and they sit behind `@PlatformAdmin()` — §10.14 said this
     view must be its own guarded route and never a widening of the org one.
     That is what these are. */

  /** Every tenant's requests, newest first, with the organization named. */
  async listAllForPlatform(filters: {
    status?: string;
    organizationId?: number;
    limit: number;
    offset: number;
  }) {
    const statusFilter = filters.status
      ? sql`AND sr.status = ${filters.status}`
      : sql``;
    const orgFilter = filters.organizationId
      ? sql`AND sr.organization_id = ${filters.organizationId}`
      : sql``;

    return this.db.all<{
      id: number;
      organization_id: number;
      organization_name: string;
      ref_no: string;
      service: string;
      timeline: string | null;
      budget: string | null;
      status: string;
      response_note: string | null;
      contact_name: string;
      contact_email: string;
      created_at: string;
      updated_at: string;
    }>(sql`
      SELECT sr.id, sr.organization_id, o.name AS organization_name,
             sr.ref_no, sr.service, sr.timeline, sr.budget, sr.status,
             sr.response_note, sr.contact_name, sr.contact_email,
             sr.created_at, sr.updated_at
        FROM service_requests sr
        JOIN organizations o ON o.id = sr.organization_id
       WHERE TRUE ${statusFilter} ${orgFilter}
       ORDER BY sr.created_at DESC
       LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
  }

  /** Counts per status across every tenant, for the queue's KPI strip. */
  async platformCounts() {
    return this.db.all<{ status: string; n: number }>(sql`
      SELECT status, COUNT(*)::int AS n FROM service_requests GROUP BY status
    `);
  }

  /** One request with its full questionnaire, from any tenant. */
  async findByIdForPlatform(id: number) {
    const rows = await this.db.all<Record<string, unknown>>(sql`
      SELECT sr.*, o.name AS organization_name
        FROM service_requests sr
        JOIN organizations o ON o.id = sr.organization_id
       WHERE sr.id = ${id}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Move a request along and write Edstellar's reply.
   *
   * The ONLY writer of `status` and `response_note`. A tenant cannot reach
   * this — marking your own request "Proposal sent" would make the status
   * meaningless.
   */
  async respond(
    id: number,
    input: { status: string; responseNote: string | null },
  ) {
    const [updated] = await this.db
      .update(serviceRequests)
      .set({
        status: input.status,
        responseNote: input.responseNote,
        updatedAt: sql`now()`,
      })
      .where(eq(serviceRequests.id, id))
      .returning();
    return updated ?? null;
  }

  /** Activity: takes the CALLER's org, always. */
  async create(scope: OrgScope, input: NewServiceRequest) {
    const [created] = await this.db
      .insert(serviceRequests)
      .values({
        organizationId: scope.organizationId,
        refNo: input.refNo,
        service: input.service,
        answers: input.answers,
        timeline: input.timeline,
        budget: input.budget,
        requestedBy: input.requestedBy,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
      })
      .returning();
    return created;
  }
}
