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
