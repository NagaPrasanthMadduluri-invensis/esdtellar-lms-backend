import { Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { dataRequests } from '@/database/schema';
import { orgScope, type OrgScope } from '@/database/org-scope';

/**
 * Reads for the "My Data" self-service (0056).
 *
 * The export side assembles everything the platform holds about ONE person,
 * strictly scoped to their own `user_id` (and, where the table has no direct
 * user column, reached through a row that does). Nothing here selects a
 * password hash, a reset-token hash, or another person's data — the two
 * genuinely sensitive columns (`users.password`, `password_reset_tokens`) are
 * never in a select list below.
 *
 * Every read is a simple per-user query on the subject's own rows, so there is
 * no N+1 concern: the data set is one person's, joined only to resolve the
 * human-readable name of the course / lesson / session a row points at.
 */
@Injectable()
export class MyDataRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /* ── The export ───────────────────────────────────────────────────────── */

  /** The subject's account record. Never selects the password hash. */
  async profile(userId: number) {
    const rows = await this.db.all<Record<string, unknown>>(sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.department,
             u.employee_id, u.job_role, u.job_level, u.location, u.phone,
             u.role, u.is_active, u.created_at, u.last_seen_at,
             o.name AS organization_name
        FROM users u
        JOIN organizations o ON o.id = u.organization_id
       WHERE u.id = ${userId}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async courseAssignments(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT a.course_id, c.name AS course_name, a.assigned_at, a.due_date,
             a.source_journey_id
        FROM user_course_assignments a
        JOIN courses c ON c.id = a.course_id
       WHERE a.user_id = ${userId}
       ORDER BY a.assigned_at DESC
    `);
  }

  async lessonCompletions(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT lc.lesson_id, l.title AS lesson_title, c.name AS course_name,
             lc.completed_at
        FROM user_lesson_completions lc
        JOIN lessons l ON l.id = lc.lesson_id
        JOIN courses c ON c.id = l.course_id
       WHERE lc.user_id = ${userId}
       ORDER BY lc.completed_at DESC
    `);
  }

  async videoProgress(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT vp.lesson_id, l.title AS lesson_title, vp.watched_seconds,
             vp.last_position_seconds, vp.updated_at
        FROM lesson_video_progress vp
        JOIN lessons l ON l.id = vp.lesson_id
       WHERE vp.user_id = ${userId}
       ORDER BY vp.updated_at DESC
    `);
  }

  async assessmentAttempts(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT at.id, at.assessment_id, a.title AS assessment_title, at.score,
             at.total_questions, at.percentage, at.is_passed, at.submitted_at
        FROM user_assessment_attempts at
        JOIN assessments a ON a.id = at.assessment_id
       WHERE at.user_id = ${userId}
       ORDER BY at.submitted_at DESC
    `);
  }

  async assessmentAnswers(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT ans.attempt_id, ans.question_id, q.question_text,
             ans.selected_option_id, ans.is_correct
        FROM user_assessment_answers ans
        JOIN user_assessment_attempts at ON at.id = ans.attempt_id
        JOIN assessment_questions q ON q.id = ans.question_id
       WHERE at.user_id = ${userId}
       ORDER BY ans.attempt_id DESC
    `);
  }

  async scormAssignments(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT sa.package_id, p.title AS package_title, sa.assigned_at
        FROM user_scorm_assignments sa
        JOIN scorm_packages p ON p.id = sa.package_id
       WHERE sa.user_id = ${userId}
       ORDER BY sa.assigned_at DESC
    `);
  }

  async scormTracking(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT t.package_id, p.title AS package_title, t.lesson_status,
             t.completion_status, t.success_status, t.score_raw, t.total_time,
             t.progress_measure, t.updated_at
        FROM scorm_tracking t
        JOIN scorm_packages p ON p.id = t.package_id
       WHERE t.user_id = ${userId}
       ORDER BY t.updated_at DESC
    `);
  }

  async scormAttempts(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT sa.package_id, p.title AS package_title, sa.attempt_number,
             sa.score_raw, sa.score_max, sa.percentage, sa.lesson_status,
             sa.completion_status, sa.success_status, sa.is_passed,
             sa.total_time, sa.submitted_at
        FROM scorm_attempts sa
        JOIN scorm_packages p ON p.id = sa.package_id
       WHERE sa.user_id = ${userId}
       ORDER BY sa.submitted_at DESC
    `);
  }

  async certificates(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT ce.certificate_code, ce.course_id, c.name AS course_name,
             ce.journey_id, j.title AS journey_title, ce.issued_at,
             ce.final_score, ce.is_revoked, ce.revoked_at
        FROM certificates ce
        LEFT JOIN courses c ON c.id = ce.course_id
        LEFT JOIN journeys j ON j.id = ce.journey_id
       WHERE ce.user_id = ${userId}
       ORDER BY ce.issued_at DESC
    `);
  }

  async journeyEnrollments(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT je.journey_id, j.title AS journey_title, je.assigned_at,
             je.due_date, je.completed_at
        FROM journey_enrollments je
        JOIN journeys j ON j.id = je.journey_id
       WHERE je.user_id = ${userId}
       ORDER BY je.assigned_at DESC
    `);
  }

  async badges(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT badge_key, journey_id, earned_at
        FROM user_badges
       WHERE user_id = ${userId}
       ORDER BY earned_at DESC
    `);
  }

  /** External certifications. The uploaded file PATH is internal and omitted. */
  async externalCertifications(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT name_on_certificate, course_name, course_minutes, authorized_body,
             file_name, status, manager_note, admin_note, created_at
        FROM external_certifications
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
    `);
  }

  async sessionRoster(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT r.session_id, s.title AS session_title, s.date, s.start_time,
             r.batch_id, r.enrolled_at
        FROM session_roster r
        JOIN sessions s ON s.id = r.session_id
       WHERE r.user_id = ${userId}
       ORDER BY r.enrolled_at DESC
    `);
  }

  async sessionWaitlist(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT w.session_id, s.title AS session_title, w.created_at
        FROM session_waitlist w
        JOIN sessions s ON s.id = w.session_id
       WHERE w.user_id = ${userId}
       ORDER BY w.created_at DESC
    `);
  }

  async sessionAttendance(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT at.session_id, s.title AS session_title, at.status, at.join_time,
             at.notes, at.marked_at
        FROM session_attendance at
        JOIN sessions s ON s.id = at.session_id
       WHERE at.user_id = ${userId}
       ORDER BY at.marked_at DESC
    `);
  }

  /** The subject's OWN session feedback — their ratings and comment. */
  async sessionFeedback(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT f.session_id, s.title AS session_title, f.rating_content,
             f.rating_trainer, f.rating_delivery, f.comment, f.created_at
        FROM session_feedback f
        JOIN sessions s ON s.id = f.session_id
       WHERE f.user_id = ${userId}
       ORDER BY f.created_at DESC
    `);
  }

  async courseFeedback(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT cf.course_id, c.name AS course_name, cf.answers, cf.created_at
        FROM course_feedback cf
        JOIN courses c ON c.id = cf.course_id
       WHERE cf.user_id = ${userId}
       ORDER BY cf.created_at DESC
    `);
  }

  /** The subject's own community posts (soft-deleted ones included, flagged). */
  async communityPosts(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT type, title, body, reply_count, like_count, created_at, edited_at,
             deleted_at
        FROM community_posts
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
    `);
  }

  async communityReplies(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT post_id, body, like_count, created_at, edited_at, deleted_at
        FROM community_replies
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
    `);
  }

  async communityReactions(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT post_id, reply_id, created_at
        FROM community_reactions
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
    `);
  }

  /**
   * Direct messages this person sent or received — their own correspondence.
   * The other party is named; the body is their own message content.
   */
  async directMessages(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT dm.id,
             CASE WHEN dm.sender_id = ${userId} THEN 'sent' ELSE 'received' END AS direction,
             other.first_name || ' ' || other.last_name AS other_party,
             dm.body, dm.read_at, dm.created_at
        FROM direct_messages dm
        JOIN users other
          ON other.id = CASE WHEN dm.sender_id = ${userId}
                             THEN dm.recipient_id ELSE dm.sender_id END
       WHERE dm.sender_id = ${userId} OR dm.recipient_id = ${userId}
       ORDER BY dm.created_at DESC
    `);
  }

  async notifications(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT type, title, body, link, read_at, created_at
        FROM notifications
       WHERE user_id = ${userId}
       ORDER BY created_at DESC
    `);
  }

  /** Emails addressed to this user. Subject + status, not the rendered body. */
  async emails(userId: number) {
    return this.db.all<Record<string, unknown>>(sql`
      SELECT type, to_email, subject, status, enqueued_at, sent_at
        FROM email_outbox
       WHERE user_id = ${userId}
       ORDER BY enqueued_at DESC
    `);
  }

  async emailPreferences(userId: number) {
    const rows = await this.db.all<Record<string, unknown>>(sql`
      SELECT all_off, groups_off, updated_at
        FROM user_email_preferences
       WHERE user_id = ${userId}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Row counts per category, for the on-screen summary. One round trip of
   * scalar subqueries rather than re-running every export query (§7.1).
   */
  async counts(userId: number) {
    const rows = await this.db.all<Record<string, number>>(sql`
      SELECT
        (SELECT COUNT(*) FROM user_course_assignments WHERE user_id = ${userId})::int AS course_assignments,
        (SELECT COUNT(*) FROM user_lesson_completions WHERE user_id = ${userId})::int AS lesson_completions,
        (SELECT COUNT(*) FROM lesson_video_progress WHERE user_id = ${userId})::int AS video_progress,
        (SELECT COUNT(*) FROM user_assessment_attempts WHERE user_id = ${userId})::int AS assessment_attempts,
        (SELECT COUNT(*) FROM user_scorm_assignments WHERE user_id = ${userId})::int AS scorm_assignments,
        (SELECT COUNT(*) FROM scorm_attempts WHERE user_id = ${userId})::int AS scorm_attempts,
        (SELECT COUNT(*) FROM certificates WHERE user_id = ${userId})::int AS certificates,
        (SELECT COUNT(*) FROM journey_enrollments WHERE user_id = ${userId})::int AS journey_enrollments,
        (SELECT COUNT(*) FROM user_badges WHERE user_id = ${userId})::int AS badges,
        (SELECT COUNT(*) FROM external_certifications WHERE user_id = ${userId})::int AS external_certifications,
        (SELECT COUNT(*) FROM session_roster WHERE user_id = ${userId})::int AS session_roster,
        (SELECT COUNT(*) FROM session_attendance WHERE user_id = ${userId})::int AS session_attendance,
        (SELECT COUNT(*) FROM session_feedback WHERE user_id = ${userId})::int AS session_feedback,
        (SELECT COUNT(*) FROM course_feedback WHERE user_id = ${userId})::int AS course_feedback,
        (SELECT COUNT(*) FROM community_posts WHERE user_id = ${userId})::int AS community_posts,
        (SELECT COUNT(*) FROM community_replies WHERE user_id = ${userId})::int AS community_replies,
        (SELECT COUNT(*) FROM direct_messages WHERE sender_id = ${userId} OR recipient_id = ${userId})::int AS direct_messages,
        (SELECT COUNT(*) FROM notifications WHERE user_id = ${userId})::int AS notifications,
        (SELECT COUNT(*) FROM email_outbox WHERE user_id = ${userId})::int AS emails
    `);
    return rows[0] ?? {};
  }

  /* ── Data requests ────────────────────────────────────────────────────── */

  async createRequest(input: {
    organizationId: number;
    userId: number;
    type: string;
    details: string | null;
  }) {
    const [created] = await this.db
      .insert(dataRequests)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        type: input.type,
        details: input.details,
      })
      .returning();
    return created;
  }

  /** The caller's own requests, newest first. */
  async listMine(userId: number, limit: number, offset: number) {
    return this.db
      .select({
        id: dataRequests.id,
        type: dataRequests.type,
        status: dataRequests.status,
        details: dataRequests.details,
        admin_note: dataRequests.adminNote,
        created_at: dataRequests.createdAt,
        handled_at: dataRequests.handledAt,
      })
      .from(dataRequests)
      .where(eq(dataRequests.userId, userId))
      .orderBy(desc(dataRequests.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /* ── Admin queue (org-scoped) ─────────────────────────────────────────── */

  async listForOrg(
    scope: OrgScope,
    filters: { status?: string; limit: number; offset: number },
  ) {
    const statusFilter = filters.status
      ? sql`AND dr.status = ${filters.status}`
      : sql``;
    return this.db.all<Record<string, unknown>>(sql`
      SELECT dr.id, dr.type, dr.status, dr.details, dr.admin_note,
             dr.user_id, u.first_name || ' ' || u.last_name AS subject_name,
             u.email AS subject_email,
             dr.handled_by, dr.handled_at, dr.created_at, dr.updated_at
        FROM data_requests dr
        JOIN users u ON u.id = dr.user_id
       WHERE ${orgScope('dr', scope)} ${statusFilter}
       ORDER BY dr.created_at DESC
       LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
  }

  async countsForOrg(scope: OrgScope) {
    return this.db.all<{ status: string; n: number }>(sql`
      SELECT dr.status, COUNT(*)::int AS n
        FROM data_requests dr
       WHERE ${orgScope('dr', scope)}
       GROUP BY dr.status
    `);
  }

  async findByIdForOrg(scope: OrgScope, id: number) {
    const rows = await this.db
      .select()
      .from(dataRequests)
      .where(
        and(
          eq(dataRequests.id, id),
          eq(dataRequests.organizationId, scope.organizationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async resolve(
    id: number,
    input: { status: string; adminNote: string | null; handledBy: number },
  ) {
    const resolved =
      input.status === 'resolved' || input.status === 'rejected';
    const [updated] = await this.db
      .update(dataRequests)
      .set({
        status: input.status,
        adminNote: input.adminNote,
        handledBy: input.handledBy,
        handledAt: resolved ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(eq(dataRequests.id, id))
      .returning();
    return updated ?? null;
  }
}
