import { Injectable, NotFoundException } from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { DATA_REQUEST_STATUSES } from '@/common/data-requests';

import { MyDataRepository } from './my-data.repository';
import type {
  CreateDataRequestDto,
  ResolveDataRequestDto,
} from './dto/data-request.dto';

const DEFAULT_LIMIT = 50;

/**
 * "My Data" self-service (0056) — PDPA Access, Portability and the request side
 * of Correction and Deletion.
 *
 * The export is strictly the caller's own data (every repository read is keyed
 * by their `user_id`), assembled into one machine-readable document. Correction
 * and deletion are LOGGED requests an admin actions, never executed here.
 */
@Injectable()
export class MyDataService {
  constructor(private readonly repository: MyDataRepository) {}

  /* ── The subject's own view ───────────────────────────────────────────── */

  /**
   * A readable summary for the screen: who the record is about, and how many
   * rows exist in each category. The full content comes from `exportAll`.
   */
  async summary(userId: number) {
    const [profile, counts] = await Promise.all([
      this.repository.profile(userId),
      this.repository.counts(userId),
    ]);
    if (!profile) throw new NotFoundException('User not found');

    return {
      subject: {
        id: profile.id,
        name: `${String(profile.first_name ?? '')} ${String(profile.last_name ?? '')}`.trim(),
        email: profile.email,
        organization_name: profile.organization_name,
      },
      counts,
      /*
       * Two high-volume telemetry logs are deliberately NOT in the export — the
       * SCORM data-model delta log and the audit log — the same reasoning §10.32
       * gives for leaving them out of the audit page: one row per keystroke
       * would bury everything a person can actually read. Stated here so the
       * export never quietly omits a category without saying so.
       */
      note:
        'This is everything the platform holds about you, except two internal ' +
        'activity logs kept for security and fine-grained SCORM telemetry, ' +
        'which are available on request to your administrator.',
    };
  }

  /** The full machine-readable export (PDPA portability). */
  async exportAll(userId: number) {
    const profile = await this.repository.profile(userId);
    if (!profile) throw new NotFoundException('User not found');

    const [
      courseAssignments,
      lessonCompletions,
      videoProgress,
      assessmentAttempts,
      assessmentAnswers,
      scormAssignments,
      scormTracking,
      scormAttempts,
      certificates,
      journeyEnrollments,
      badges,
      externalCertifications,
      sessionRoster,
      sessionWaitlist,
      sessionAttendance,
      sessionFeedback,
      courseFeedback,
      communityPosts,
      communityReplies,
      communityReactions,
      directMessages,
      notifications,
      emails,
      emailPreferences,
    ] = await Promise.all([
      this.repository.courseAssignments(userId),
      this.repository.lessonCompletions(userId),
      this.repository.videoProgress(userId),
      this.repository.assessmentAttempts(userId),
      this.repository.assessmentAnswers(userId),
      this.repository.scormAssignments(userId),
      this.repository.scormTracking(userId),
      this.repository.scormAttempts(userId),
      this.repository.certificates(userId),
      this.repository.journeyEnrollments(userId),
      this.repository.badges(userId),
      this.repository.externalCertifications(userId),
      this.repository.sessionRoster(userId),
      this.repository.sessionWaitlist(userId),
      this.repository.sessionAttendance(userId),
      this.repository.sessionFeedback(userId),
      this.repository.courseFeedback(userId),
      this.repository.communityPosts(userId),
      this.repository.communityReplies(userId),
      this.repository.communityReactions(userId),
      this.repository.directMessages(userId),
      this.repository.notifications(userId),
      this.repository.emails(userId),
      this.repository.emailPreferences(userId),
    ]);

    return {
      export_version: 1,
      generated_at: new Date().toISOString(),
      subject: {
        id: profile.id,
        name: `${String(profile.first_name ?? '')} ${String(profile.last_name ?? '')}`.trim(),
        email: profile.email,
        organization_name: profile.organization_name,
      },
      account: profile,
      learning: {
        course_assignments: courseAssignments,
        lesson_completions: lessonCompletions,
        video_progress: videoProgress,
        assessment_attempts: assessmentAttempts,
        assessment_answers: assessmentAnswers,
        scorm_assignments: scormAssignments,
        scorm_tracking: scormTracking,
        scorm_attempts: scormAttempts,
        certificates,
        journey_enrollments: journeyEnrollments,
        badges,
        external_certifications: externalCertifications,
      },
      sessions: {
        roster: sessionRoster,
        waitlist: sessionWaitlist,
        attendance: sessionAttendance,
      },
      feedback: {
        session_feedback: sessionFeedback,
        course_feedback: courseFeedback,
      },
      community: {
        posts: communityPosts,
        replies: communityReplies,
        reactions: communityReactions,
      },
      communications: {
        direct_messages: directMessages,
        notifications,
        emails,
        email_preferences: emailPreferences,
      },
    };
  }

  /** A download filename unique to the person and the moment. */
  exportFilename(profile: { email?: unknown }, userId: number): string {
    const date = new Date().toISOString().slice(0, 10);
    const who =
      typeof profile.email === 'string'
        ? profile.email.split('@')[0].replace(/[^a-z0-9]+/gi, '-')
        : `user-${userId}`;
    return `my-data-${who}-${date}.json`;
  }

  /* ── Requests (the subject files; an admin actions) ───────────────────── */

  async createRequest(
    userId: number,
    organizationId: number,
    dto: CreateDataRequestDto,
  ) {
    const created = await this.repository.createRequest({
      organizationId,
      userId,
      type: dto.type,
      details: dto.details ?? null,
    });
    return { request: this.shapeRequest(created) };
  }

  async listMyRequests(userId: number, limit = DEFAULT_LIMIT, offset = 0) {
    const requests = await this.repository.listMine(userId, limit, offset);
    return { requests };
  }

  /* ── Admin queue ──────────────────────────────────────────────────────── */

  async listRequests(
    scope: OrgScope,
    filters: { status?: string; limit?: number; offset?: number },
  ) {
    const [requests, counts] = await Promise.all([
      this.repository.listForOrg(scope, {
        status: filters.status,
        limit: filters.limit ?? 100,
        offset: filters.offset ?? 0,
      }),
      this.repository.countsForOrg(scope),
    ]);

    const byStatus = Object.fromEntries(
      DATA_REQUEST_STATUSES.map((s) => [s, 0]),
    ) as Record<string, number>;
    let total = 0;
    for (const row of counts) {
      byStatus[row.status] = Number(row.n);
      total += Number(row.n);
    }

    return { requests, counts: { ...byStatus, total } };
  }

  async resolveRequest(
    scope: OrgScope,
    id: number,
    adminId: number,
    dto: ResolveDataRequestDto,
  ) {
    const existing = await this.repository.findByIdForOrg(scope, id);
    if (!existing) throw new NotFoundException('Request not found');

    const updated = await this.repository.resolve(id, {
      status: dto.status,
      adminNote: dto.admin_note ?? null,
      handledBy: adminId,
    });
    if (!updated) throw new NotFoundException('Request not found');

    return { request: this.shapeRequest(updated) };
  }

  private shapeRequest(row: {
    id: number;
    type: string;
    status: string;
    details: string | null;
    adminNote: string | null;
    handledBy: number | null;
    handledAt: string | null;
    createdAt: string;
    updatedAt: string;
  }) {
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      details: row.details,
      admin_note: row.adminNote,
      handled_by: row.handledBy,
      handled_at: row.handledAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
}
