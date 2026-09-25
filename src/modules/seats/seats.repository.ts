import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { organizations } from '@/database/schema';
import { orgScope, type OrgScope } from '@/database/org-scope';

@Injectable()
export class SeatsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Seats used and the limit, for one organization.
   *
   * A seat is an ACTIVE LEARNER. Deactivated learners are excluded so that
   * freeing a seat by deactivating somebody actually works, and admins,
   * managers and trainers are excluded because they are not seats — both
   * decisions are spelled out in `0028_seat_limits.sql`.
   */
  async usage(scope: OrgScope) {
    const rows = await this.db.all<{
      seat_limit: number | null;
      used: number;
      admins: number;
      trainers: number;
      learners: number;
      onboarded_at: string;
    }>(sql`
      SELECT o.seat_limit,
             o.created_at AS onboarded_at,
             (SELECT COUNT(*)::int FROM users u
               WHERE u.organization_id = o.id
                 AND u.role = 'learner' AND u.is_active = 1) AS used,
             /*
              * The breakdown the Seat Licence panel shows beside the meter.
              * (No backticks in this literal -- it sits inside a tagged
              * template and one would open a JS substitution.)
              *
              * learners is the SAME predicate as used above, deliberately
              * duplicated rather than aliased: the panel prints both, and if
              * they ever stop being the same number that is a bug worth
              * seeing rather than one the query hides.
              *
              * All three partition on users.role, the portal selector, so
              * admins + trainers + learners is exactly the active headcount
              * with nobody double counted. A MANAGER rides in the learner
              * portal (rbac decision 2) and therefore counts as a learner
              * here and consumes a seat -- which is what used has always
              * done, stated now rather than left to be discovered.
              */
             (SELECT COUNT(*)::int FROM users u
               WHERE u.organization_id = o.id
                 AND u.role = 'admin' AND u.is_active = 1) AS admins,
             (SELECT COUNT(*)::int FROM users u
               WHERE u.organization_id = o.id
                 AND u.role = 'trainer' AND u.is_active = 1) AS trainers,
             (SELECT COUNT(*)::int FROM users u
               WHERE u.organization_id = o.id
                 AND u.role = 'learner' AND u.is_active = 1) AS learners
        FROM organizations o
       WHERE o.id = ${scope.organizationId}
       LIMIT 1
    `);
    return (
      rows[0] ?? {
        seat_limit: null,
        used: 0,
        admins: 0,
        trainers: 0,
        learners: 0,
        onboarded_at: '',
      }
    );
  }

  /** The same figures for every tenant — the platform's seat column. */
  async usageForAll() {
    return this.db.all<{
      organization_id: number;
      seat_limit: number | null;
      used: number;
    }>(sql`
      SELECT o.id AS organization_id, o.seat_limit,
             (SELECT COUNT(*)::int FROM users u
               WHERE u.organization_id = o.id
                 AND u.role = 'learner' AND u.is_active = 1) AS used
        FROM organizations o
       WHERE NOT o.is_platform
    `);
  }

  async setSeatLimit(organizationId: number, seatLimit: number | null) {
    const [updated] = await this.db
      .update(organizations)
      .set({ seatLimit })
      .where(eq(organizations.id, organizationId))
      .returning({ id: organizations.id, seatLimit: organizations.seatLimit });
    return updated ?? null;
  }

  /* ── Requests ── */

  /** This tenant's own requests, newest first. */
  async listForOrg(scope: OrgScope) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT sr.* FROM seat_requests sr
       WHERE ${orgScope('sr', scope)}
       ORDER BY sr.created_at DESC
    `);
  }

  async findOpenForOrg(scope: OrgScope) {
    const rows = await this.db.all<Record<string, unknown>>(sql`
      SELECT sr.* FROM seat_requests sr
       WHERE ${orgScope('sr', scope)} AND sr.status = 'pending'
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Every tenant's requests — PLATFORM ONLY, behind `@PlatformAdmin()`. */
  async listAllForPlatform(status?: string) {
    const statusFilter = status ? sql`AND sr.status = ${status}` : sql``;
    return this.db.all<Record<string, unknown>>(sql`
      SELECT sr.*, o.name AS organization_name, o.seat_limit AS live_limit,
             (SELECT COUNT(*)::int FROM users u
               WHERE u.organization_id = sr.organization_id
                 AND u.role = 'learner' AND u.is_active = 1) AS live_used
        FROM seat_requests sr
        JOIN organizations o ON o.id = sr.organization_id
       WHERE TRUE ${statusFilter}
       ORDER BY CASE WHEN sr.status = 'pending' THEN 0 ELSE 1 END,
                sr.created_at DESC
    `);
  }

  async findByIdForPlatform(id: number) {
    const rows = await this.db.all<Record<string, unknown>>(sql`
      SELECT sr.*, o.name AS organization_name
        FROM seat_requests sr
        JOIN organizations o ON o.id = sr.organization_id
       WHERE sr.id = ${id} LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async create(input: {
    organizationId: number;
    requestedSeats: number;
    currentLimit: number | null;
    currentUsed: number;
    reason: string | null;
    requestedBy: number;
    contactName: string;
    contactEmail: string;
  }) {
    /**
     * Raw SQL, not `.insert().returning()`, so this agrees with its own
     * siblings.
     *
     * `listForOrg` and `listAllForPlatform` are raw SQL and hand back
     * snake_case, which is what the API contract and the browser read. A
     * Drizzle `.returning()` here would return camelCase, so the row the
     * tenant gets back from POST would name every field differently from the
     * rows it gets from GET — `requested_seats` undefined on the one screen
     * that has just been told the request was filed. That is the §10.10 shape
     * bug, and this repository is not going to be its seventh occurrence.
     */
    const rows = await this.db.all<Record<string, unknown>>(sql`
      INSERT INTO seat_requests
        (organization_id, requested_seats, current_limit, current_used,
         reason, requested_by, contact_name, contact_email)
      VALUES
        (${input.organizationId}, ${input.requestedSeats}, ${input.currentLimit},
         ${input.currentUsed}, ${input.reason}, ${input.requestedBy},
         ${input.contactName}, ${input.contactEmail})
      RETURNING *
    `);
    return rows[0];
  }

  async respond(
    id: number,
    input: {
      status: string;
      responseNote: string | null;
      approvedSeats: number | null;
    },
  ) {
    // Raw SQL for the same reason `create` is — see its comment.
    const rows = await this.db.all<Record<string, unknown>>(sql`
      UPDATE seat_requests
         SET status = ${input.status},
             response_note = ${input.responseNote},
             approved_seats = ${input.approvedSeats},
             updated_at = now()
       WHERE id = ${id}
      RETURNING *
    `);
    return rows[0] ?? null;
  }
}
