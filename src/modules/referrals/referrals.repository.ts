import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { referrals } from '@/database/schema';
import { orgScope, type OrgScope } from '@/database/org-scope';
import { REFERRAL_CONVERTED } from '@/common/referrals';

export interface NewReferral {
  refNo: string;
  referredBy: number;
  referrerName: string;
  referrerEmail: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  industry: string | null;
  country: string | null;
  teamSize: string | null;
  notes: string | null;
  inviteEmailAt: string | null;
}

@Injectable()
export class ReferralsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * This organization's referrals, newest first.
   *
   * `orgScope`, and there is no content half: a referral is activity, owned by
   * the referrer (§10.12). The platform reads every tenant's through the
   * cross-tenant methods below.
   */
  async list(scope: OrgScope, limit: number, offset: number) {
    return this.db
      .select({
        id: referrals.id,
        ref_no: referrals.refNo,
        company_name: referrals.companyName,
        contact_name: referrals.contactName,
        contact_email: referrals.contactEmail,
        industry: referrals.industry,
        country: referrals.country,
        team_size: referrals.teamSize,
        status: referrals.status,
        platform_note: referrals.platformNote,
        converted_at: referrals.convertedAt,
        created_at: referrals.createdAt,
      })
      .from(referrals)
      .where(eq(referrals.organizationId, scope.organizationId))
      .orderBy(desc(referrals.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /** Counts per status in this org, for the tiles. */
  async counts(scope: OrgScope) {
    return this.db.all<{ status: string; n: number }>(sql`
      SELECT status, COUNT(*)::int AS n
      FROM referrals r
      WHERE ${orgScope('r', scope)}
      GROUP BY status
    `);
  }

  /** Converted referrals in this org — the reward tier's one input. */
  async convertedCount(scope: OrgScope): Promise<number> {
    const [row] = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM referrals r
      WHERE ${orgScope('r', scope)} AND r.status = ${REFERRAL_CONVERTED}
    `);
    return Number(row?.n ?? 0);
  }

  /** One referral in this org, with everything. */
  async findById(scope: OrgScope, id: number) {
    const rows = await this.db
      .select()
      .from(referrals)
      .where(
        and(
          eq(referrals.id, id),
          eq(referrals.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Has this prospect email already been referred? First-touch attribution, so
   * the check is GLOBAL (not org-scoped) — a second org referring the same
   * address is refused. Returns the existing row's org + ref for the message.
   */
  async findByEmail(email: string) {
    const rows = await this.db.all<{
      id: number;
      organization_id: number;
      ref_no: string;
    }>(sql`
      SELECT id, organization_id, ref_no
      FROM referrals
      WHERE LOWER(contact_email) = ${email.toLowerCase()}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * The next reference number for this organization, from the highest existing
   * suffix — the same shape as `ServicesRepository.nextRefNo` (read its note).
   * The unique index is the real guarantee; this only has to be right almost
   * always.
   */
  async nextRefNo(scope: OrgScope, year: number): Promise<string> {
    const prefix = `REF-${year}-`;
    const rows = await this.db.all<{ n: number | null }>(sql`
      SELECT MAX(NULLIF(regexp_replace(ref_no, '^.*-', ''), '')::int) AS n
      FROM referrals r
      WHERE ${orgScope('r', scope)} AND r.ref_no LIKE ${prefix + '%'}
    `);
    const next = Number(rows[0]?.n ?? 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  /** The referrer org's name, for the invite email's branding. */
  async organizationName(organizationId: number): Promise<string | null> {
    const rows = await this.db.all<{ name: string }>(sql`
      SELECT name FROM organizations WHERE id = ${organizationId} LIMIT 1
    `);
    return rows[0]?.name ?? null;
  }

  /** Whether an org id names a real organization — validates a conversion link. */
  async organizationExists(id: number): Promise<boolean> {
    const rows = await this.db.all<{ id: number }>(sql`
      SELECT id FROM organizations WHERE id = ${id} LIMIT 1
    `);
    return Boolean(rows[0]);
  }

  /** Activity: takes the CALLER's org, always. */
  async create(scope: OrgScope, input: NewReferral) {
    const [created] = await this.db
      .insert(referrals)
      .values({
        organizationId: scope.organizationId,
        refNo: input.refNo,
        referredBy: input.referredBy,
        referrerName: input.referrerName,
        referrerEmail: input.referrerEmail,
        companyName: input.companyName,
        contactName: input.contactName,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        industry: input.industry,
        country: input.country,
        teamSize: input.teamSize,
        notes: input.notes,
        inviteEmailAt: input.inviteEmailAt,
      })
      .returning();
    return created;
  }

  /* ── Platform (super-admin) ────────────────────────────────────────────
     CROSS-TENANT ON PURPOSE, and the only methods here that are. Behind
     `@PlatformAdmin()` — §10.36 said this view is its own guarded route, never
     a widening of the org one. */

  /** Every tenant's referrals, newest first, with the referrer org named. */
  async listAllForPlatform(filters: {
    status?: string;
    organizationId?: number;
    limit: number;
    offset: number;
  }) {
    const statusFilter = filters.status
      ? sql`AND r.status = ${filters.status}`
      : sql``;
    const orgFilter = filters.organizationId
      ? sql`AND r.organization_id = ${filters.organizationId}`
      : sql``;

    return this.db.all<{
      id: number;
      organization_id: number;
      organization_name: string;
      ref_no: string;
      referrer_name: string;
      referrer_email: string;
      company_name: string;
      contact_name: string;
      contact_email: string;
      contact_phone: string | null;
      industry: string | null;
      country: string | null;
      team_size: string | null;
      status: string;
      platform_note: string | null;
      converted_organization_id: number | null;
      converted_organization_name: string | null;
      converted_at: string | null;
      created_at: string;
      updated_at: string;
    }>(sql`
      SELECT r.id, r.organization_id, o.name AS organization_name,
             r.ref_no, r.referrer_name, r.referrer_email,
             r.company_name, r.contact_name, r.contact_email, r.contact_phone,
             r.industry, r.country, r.team_size, r.status, r.platform_note,
             r.converted_organization_id, c.name AS converted_organization_name,
             r.converted_at, r.created_at, r.updated_at
        FROM referrals r
        JOIN organizations o ON o.id = r.organization_id
        LEFT JOIN organizations c ON c.id = r.converted_organization_id
       WHERE TRUE ${statusFilter} ${orgFilter}
       ORDER BY r.created_at DESC
       LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
  }

  /** Counts per status across every tenant, for the queue's KPI strip. */
  async platformCounts() {
    return this.db.all<{ status: string; n: number }>(sql`
      SELECT status, COUNT(*)::int AS n FROM referrals GROUP BY status
    `);
  }

  /** One referral from any tenant, with both org names. */
  async findByIdForPlatform(id: number) {
    const rows = await this.db.all<Record<string, unknown>>(sql`
      SELECT r.*, o.name AS organization_name,
             c.name AS converted_organization_name
        FROM referrals r
        JOIN organizations o ON o.id = r.organization_id
        LEFT JOIN organizations c ON c.id = r.converted_organization_id
       WHERE r.id = ${id}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Move a referral along and write Edstellar's reply.
   *
   * The ONLY writer of `status`, `platform_note` and the conversion link. A
   * tenant cannot reach this — marking your own referral "converted" would earn
   * you a discount for nothing. `converted_at` is stamped the first time it
   * reaches `converted` and cleared if it moves back off it, so the reward
   * count and the badge stay honest.
   */
  async respond(
    id: number,
    input: {
      status: string;
      platformNote: string | null;
      convertedOrganizationId: number | null;
    },
  ) {
    const converting = input.status === REFERRAL_CONVERTED;
    const [updated] = await this.db
      .update(referrals)
      .set({
        status: input.status,
        platformNote: input.platformNote,
        convertedOrganizationId: converting ? input.convertedOrganizationId : null,
        convertedAt: converting ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(eq(referrals.id, id))
      .returning();
    return updated ?? null;
  }
}
