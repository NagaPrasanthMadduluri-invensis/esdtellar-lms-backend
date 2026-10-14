import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import { REFERRAL_STATUSES, REFERRAL_CONVERTED } from '@/common/referrals';
import { referralTier } from '@/common/referral-rewards';
import { actorLabel } from '@/common/notifications';
import { PRODUCT_FULL } from '@/modules/email/email-brand';
import { ActivityService } from '@/modules/activity/activity.service';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { EmailOutboxService } from '@/modules/email/email-outbox.service';

import { ReferralsRepository } from './referrals.repository';
import type {
  CreateReferralDto,
  RespondToReferralDto,
} from './dto/referral.dto';

const DEFAULT_LIMIT = 50;

@Injectable()
export class ReferralsService {
  constructor(
    private readonly repository: ReferralsRepository,
    private readonly activity: ActivityService,
    /** Best-effort (§8.4) — neither `notify` nor `enqueueDirect` can throw. */
    private readonly notifications: NotificationsService,
    private readonly email: EmailOutboxService,
  ) {}

  /* ── Tenant (the referring org admin) ─────────────────────────────────── */

  /**
   * This organization's referrals, the KPI counts, and the earned reward tier.
   *
   * The tier is DERIVED from the converted count in the same read (§10.36), so
   * the showcase banner can never disagree with the list beneath it.
   */
  async list(scope: OrgScope, limit = DEFAULT_LIMIT, offset = 0) {
    const [referrals, counts, convertedCount] = await Promise.all([
      this.repository.list(scope, limit, offset),
      this.repository.counts(scope),
      this.repository.convertedCount(scope),
    ]);

    const byStatus = Object.fromEntries(
      REFERRAL_STATUSES.map((s) => [s, 0]),
    ) as Record<string, number>;
    let total = 0;
    for (const row of counts) {
      byStatus[row.status] = Number(row.n);
      total += Number(row.n);
    }

    return {
      referrals,
      counts: { ...byStatus, total },
      reward: referralTier(convertedCount),
    };
  }

  async get(scope: OrgScope, id: number) {
    const referral = await this.repository.findById(scope, id);
    if (!referral) throw new NotFoundException('Referral not found');
    return { referral: this.shape(referral) };
  }

  /**
   * File a referral.
   *
   * Everything identifying the referrer is taken from the VERIFIED TOKEN, never
   * the body (§5.3) — the organization, the user id, and the name and email the
   * referral is signed with. The invite email is sent IMMEDIATELY, on Edstellar's
   * brand, to the prospect's address: the admin is vouching.
   */
  async create(
    scope: OrgScope,
    actor: AuthenticatedUser,
    dto: CreateReferralDto,
  ) {
    // First-touch attribution: a prospect can be referred once, globally.
    const existing = await this.repository.findByEmail(dto.contact_email);
    if (existing) {
      throw new ConflictException(
        'That company contact has already been referred.',
      );
    }

    const refNo = await this.repository.nextRefNo(scope, new Date().getFullYear());
    const nowIso = new Date().toISOString();

    const referral = await this.repository.create(scope, {
      refNo,
      referredBy: actor.userId,
      referrerName: actorLabel(actor),
      referrerEmail: actor.email,
      companyName: dto.company_name,
      contactName: dto.contact_name,
      contactEmail: dto.contact_email,
      contactPhone: dto.contact_phone ?? null,
      industry: dto.industry ?? null,
      country: dto.country ?? null,
      teamSize: dto.team_size ?? null,
      notes: dto.notes ?? null,
      inviteEmailAt: nowIso,
    });

    // The invitation email — best-effort, to a non-user address (§10.36).
    const orgName = await this.repository.organizationName(scope.organizationId);
    void this.sendInvite(scope.organizationId, referral.id, orgName, dto);

    // Dashboard feed entry — best-effort (§8.4).
    void this.activity.record(scope, {
      type: 'referral_submitted',
      detail: `${dto.company_name} (${refNo})`,
      actor,
      subjectType: 'referral',
      subjectId: referral.id,
    });

    // Tell Edstellar's own staff a referral landed (bell only — §10.36).
    void this.notifications.notifyPlatform({
      type: 'referral_received',
      title: `${dto.company_name} — new referral`,
      body: `${actorLabel(actor)} referred ${dto.company_name} (${refNo}). Open the queue to follow up.`,
      link: '/platform/referrals',
      subjectType: 'referral',
      subjectId: referral.id,
      actorName: actorLabel(actor),
    });

    return { referral: this.shape(referral) };
  }

  /** Compose and enqueue the prospect's invitation. Never throws. */
  private async sendInvite(
    organizationId: number,
    referralId: number,
    orgName: string | null,
    dto: CreateReferralDto,
  ): Promise<void> {
    const by = orgName ?? 'An organisation';
    const subject = orgName
      ? `${orgName} referred you to ${PRODUCT_FULL}`
      : `You have been referred to ${PRODUCT_FULL}`;

    // One blank line per paragraph (the renderer splits on it). No em dashes in
    // user-facing copy (project rule).
    const body = [
      `${by} uses ${PRODUCT_FULL} and thought it could be a good fit for ${dto.company_name}.`,
      `Spectra is Edstellar's enterprise learning platform. It brings instructor led training across 2,000+ skills, live and virtual sessions with vetted trainers, SCORM and video courses, structured learning paths, and analytics that measure real learning hours rather than logins, all in one place.`,
      `If that sounds useful, discover Spectra below, or simply reply to this email and the Edstellar team will be glad to connect.`,
    ].join('\n\n');

    const facts: Array<{ label: string; value: string }> = [];
    if (orgName) facts.push({ label: 'Referred by', value: orgName });
    facts.push({ label: 'For', value: dto.company_name });
    facts.push({ label: 'Contact', value: dto.contact_name });

    await this.email.enqueueDirect({
      organizationId,
      type: 'referral_invite',
      toEmail: dto.contact_email,
      toName: dto.contact_name,
      orgName,
      subject,
      body,
      facts,
      // Relative, so it resolves to the public Spectra origin at render time.
      // It is deliberately not a sign-in or onboarding link — this creates no
      // account.
      link: '/',
      subjectType: 'referral',
      subjectId: referralId,
    });
  }

  /* ── Platform (super-admin) ───────────────────────────────────────────
     Behind `@PlatformAdmin()`. The only methods that cross tenants, and the
     only writer of a referral's status (§10.36). */

  async listForPlatform(query: {
    status?: string;
    organization_id?: number;
    limit?: number;
    offset?: number;
  }) {
    const [referrals, counts] = await Promise.all([
      this.repository.listAllForPlatform({
        status: query.status,
        organizationId: query.organization_id,
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
      }),
      this.repository.platformCounts(),
    ]);

    const byStatus = Object.fromEntries(
      REFERRAL_STATUSES.map((s) => [s, 0]),
    ) as Record<string, number>;
    let total = 0;
    for (const row of counts) {
      byStatus[row.status] = Number(row.n);
      total += Number(row.n);
    }

    return { referrals, counts: { ...byStatus, total } };
  }

  async getForPlatform(id: number) {
    const row = await this.repository.findByIdForPlatform(id);
    if (!row) throw new NotFoundException('Referral not found');
    // Raw SQL (snake_case already) — not passed through `shape()`, which exists
    // to convert a Drizzle camelCase row. The §10.10 seam this file shares with
    // ServicesService.
    return { referral: row };
  }

  /** Move a referral along, link a conversion, and reward the referrer. */
  async respond(id: number, dto: RespondToReferralDto) {
    const existing = await this.repository.findByIdForPlatform(id);
    if (!existing) throw new NotFoundException('Referral not found');

    const converting = dto.status === REFERRAL_CONVERTED;
    const convertedOrgId = dto.converted_organization_id ?? null;

    if (converting && convertedOrgId !== null) {
      const exists = await this.repository.organizationExists(convertedOrgId);
      if (!exists) {
        throw new BadRequestException(
          'converted_organization_id does not name an organization',
        );
      }
    }

    const updated = await this.repository.respond(id, {
      status: dto.status,
      platformNote: dto.platform_note ?? null,
      convertedOrganizationId: convertedOrgId,
    });
    if (!updated) throw new NotFoundException('Referral not found');

    /*
     * Tell the referrer when their referral BECOMES a customer — a transition,
     * not every save, so re-saving a converted referral does not re-ring the
     * bell. `referred_by` and `organization_id` come from `existing`, the raw
     * snake_case row.
     */
    const wasConverted = String(existing.status) === REFERRAL_CONVERTED;
    const referrerId = Number(existing.referred_by);
    const referrerOrgId = Number(existing.organization_id);
    if (
      converting &&
      !wasConverted &&
      Number.isInteger(referrerId) &&
      Number.isInteger(referrerOrgId)
    ) {
      void this.notifications.notify({
        userIds: [referrerId],
        organizationId: referrerOrgId,
        type: 'referral_converted',
        title: `${String(existing.company_name)} is now a Spectra customer`,
        body:
          dto.platform_note?.trim() ||
          `Your referral ${String(existing.ref_no)} converted. Check your reward tier.`,
        link: '/admin/referrals',
        subjectType: 'referral',
        subjectId: id,
        actorName: 'Edstellar',
      });
    }

    return { referral: this.shape(updated) };
  }

  /**
   * snake_case, like every other response (§8.1). `create`/`respond`/`findById`
   * are Drizzle calls returning camelCase; the raw-SQL platform reads are not
   * shaped (§10.10).
   */
  private shape(row: {
    id: number;
    refNo: string;
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
    status: string;
    platformNote: string | null;
    convertedOrganizationId: number | null;
    convertedAt: string | null;
    inviteEmailAt: string | null;
    createdAt: string;
    updatedAt: string;
  }) {
    return {
      id: row.id,
      ref_no: row.refNo,
      referrer_name: row.referrerName,
      referrer_email: row.referrerEmail,
      company_name: row.companyName,
      contact_name: row.contactName,
      contact_email: row.contactEmail,
      contact_phone: row.contactPhone,
      industry: row.industry,
      country: row.country,
      team_size: row.teamSize,
      notes: row.notes,
      status: row.status,
      platform_note: row.platformNote,
      converted_organization_id: row.convertedOrganizationId,
      converted_at: row.convertedAt,
      invite_email_at: row.inviteEmailAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
