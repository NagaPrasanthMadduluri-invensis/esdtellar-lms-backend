import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import { EXTERNAL_LESSON_CONTENT_TYPE } from '@/common/external-certifications';

/**
 * Every query over `external_certifications`.
 *
 * Raw SQL throughout, snake_case rows (§10.10) — including the writes, so
 * there is no casing seam between what an insert returns and what a read
 * does. That is the defect this codebase has now shipped seven times.
 *
 * ACTIVITY, so `orgScope` everywhere and never `contentScope`: a
 * certification belongs to exactly one learner in exactly one tenant, and
 * there is no shared version of one to widen to.
 */

export interface ExternalCertRow {
  id: number;
  organization_id: number;
  user_id: number;
  learner_name: string;
  learner_email: string;
  department: string | null;
  name_on_certificate: string;
  course_name: string;
  course_minutes: number;
  authorized_body: string;
  file_name: string;
  file_mime: string;
  file_size_bytes: number;
  status: string;
  manager_user_id: number | null;
  manager_name: string | null;
  manager_decided_at: string | null;
  manager_note: string | null;
  admin_decided_by: number | null;
  admin_decided_at: string | null;
  admin_note: string | null;
  course_id: number | null;
  created_at: string;
}

@Injectable()
export class ExternalCertificationsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** The columns every read returns, so the three audiences cannot drift
   *  apart in shape. `file_path` is deliberately NOT among them — it is a
   *  disk location, and only `findFile` below needs it. */
  private get columns() {
    return sql`
      ec.id, ec.organization_id, ec.user_id,
      TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS learner_name,
      u.email AS learner_email,
      u.department,
      ec.name_on_certificate, ec.course_name, ec.course_minutes,
      ec.authorized_body,
      ec.file_name, ec.file_mime, ec.file_size_bytes,
      ec.status,
      ec.manager_user_id,
      TRIM(COALESCE(m.first_name, '') || ' ' || COALESCE(m.last_name, '')) AS manager_name,
      ec.manager_decided_at, ec.manager_note,
      ec.admin_decided_by, ec.admin_decided_at, ec.admin_note,
      ec.course_id, ec.created_at
    `;
  }

  private get joins() {
    return sql`
      FROM external_certifications ec
      JOIN users u ON u.id = ec.user_id
 LEFT JOIN users m ON m.id = ec.manager_user_id
    `;
  }

  async create(input: {
    scope: OrgScope;
    userId: number;
    nameOnCertificate: string;
    courseName: string;
    courseMinutes: number;
    authorizedBody: string;
    filePath: string;
    fileName: string;
    fileMime: string;
    fileSizeBytes: number;
    managerUserId: number | null;
    status: string;
  }): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO external_certifications
        (organization_id, user_id, name_on_certificate, course_name,
         course_minutes, authorized_body, file_path, file_name, file_mime,
         file_size_bytes, manager_user_id, status)
      VALUES (${input.scope.organizationId}, ${input.userId},
              ${input.nameOnCertificate}, ${input.courseName},
              ${input.courseMinutes}, ${input.authorizedBody},
              ${input.filePath}, ${input.fileName}, ${input.fileMime},
              ${input.fileSizeBytes}, ${input.managerUserId}, ${input.status})
      RETURNING id
    `);
    return rows[0].id;
  }

  async findById(
    scope: OrgScope,
    id: number,
  ): Promise<ExternalCertRow | null> {
    const rows = await this.db.all<ExternalCertRow>(sql`
      SELECT ${this.columns} ${this.joins}
       WHERE ec.id = ${id} AND ${orgScope('ec', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** A learner's own submissions, newest first. */
  async listForLearner(
    scope: OrgScope,
    userId: number,
  ): Promise<ExternalCertRow[]> {
    return this.db.all<ExternalCertRow>(sql`
      SELECT ${this.columns} ${this.joins}
       WHERE ec.user_id = ${userId} AND ${orgScope('ec', scope)}
       ORDER BY ec.created_at DESC
    `);
  }

  /**
   * What is waiting on THIS manager.
   *
   * Filtered on `manager_user_id`, the person the row was sent to at
   * submission — not on the learner's current manager. A reporting line that
   * changes while a claim is in flight must not move somebody else's
   * decision onto a new desk, and the old manager is the one who was asked.
   */
  async listForManager(
    scope: OrgScope,
    managerUserId: number,
  ): Promise<ExternalCertRow[]> {
    return this.db.all<ExternalCertRow>(sql`
      SELECT ${this.columns} ${this.joins}
       WHERE ec.manager_user_id = ${managerUserId}
         AND ec.status = 'pending_manager'
         AND ${orgScope('ec', scope)}
       ORDER BY ec.created_at
    `);
  }

  /** Everything in the org, optionally narrowed to one status. */
  async listForAdmin(
    scope: OrgScope,
    status: string | undefined,
    limit: number,
    offset: number,
  ): Promise<ExternalCertRow[]> {
    const statusFilter = status ? sql` AND ec.status = ${status}` : sql``;
    return this.db.all<ExternalCertRow>(sql`
      SELECT ${this.columns} ${this.joins}
       WHERE ${orgScope('ec', scope)}${statusFilter}
       -- Pending first: the queue is the reason an admin opens this, and a
       -- decided row is history. Within each, oldest first — somebody has
       -- been waiting.
       ORDER BY CASE WHEN ec.status = 'pending_admin' THEN 0
                     WHEN ec.status = 'pending_manager' THEN 1
                     ELSE 2 END,
                ec.created_at
       LIMIT ${limit} OFFSET ${offset}
    `);
  }

  async countForAdmin(scope: OrgScope, status: string | undefined) {
    const statusFilter = status ? sql` AND ec.status = ${status}` : sql``;
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM external_certifications ec
       WHERE ${orgScope('ec', scope)}${statusFilter}
    `);
    return rows[0]?.n ?? 0;
  }

  /** Counts for the admin page's tiles, reduced in SQL rather than by
   *  fetching every row to count them in JavaScript (§7.2). */
  async statusCounts(scope: OrgScope): Promise<Record<string, number>> {
    const rows = await this.db.all<{ status: string; n: number }>(sql`
      SELECT ec.status, COUNT(*)::int AS n
        FROM external_certifications ec
       WHERE ${orgScope('ec', scope)}
       GROUP BY ec.status
    `);
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  }

  /** The one read that returns a disk path, and the only one. */
  async findFile(
    scope: OrgScope,
    id: number,
  ): Promise<{
    id: number;
    user_id: number;
    manager_user_id: number | null;
    file_path: string;
    file_name: string;
    file_mime: string;
  } | null> {
    const rows = await this.db.all<{
      id: number;
      user_id: number;
      manager_user_id: number | null;
      file_path: string;
      file_name: string;
      file_mime: string;
    }>(sql`
      SELECT ec.id, ec.user_id, ec.manager_user_id,
             ec.file_path, ec.file_name, ec.file_mime
        FROM external_certifications ec
       WHERE ec.id = ${id} AND ${orgScope('ec', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  async recordManagerDecision(
    scope: OrgScope,
    id: number,
    input: { status: string; decidedBy: number; note: string | null },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE external_certifications ec
         SET status = ${input.status},
             manager_decided_by = ${input.decidedBy},
             manager_decided_at = now(),
             manager_note = ${input.note},
             updated_at = now()
       WHERE ec.id = ${id} AND ${orgScope('ec', scope)}
    `);
  }

  async recordAdminDecision(
    scope: OrgScope,
    id: number,
    input: {
      status: string;
      decidedBy: number;
      note: string | null;
      courseId: number | null;
    },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE external_certifications ec
         SET status = ${input.status},
             admin_decided_by = ${input.decidedBy},
             admin_decided_at = now(),
             admin_note = ${input.note},
             course_id = COALESCE(${input.courseId}, ec.course_id),
             updated_at = now()
       WHERE ec.id = ${id} AND ${orgScope('ec', scope)}
    `);
  }

  /**
   * Everything an approval creates, in ONE statement: the companion course,
   * its single module, its single lesson, the learner's assignment and the
   * completion that makes it count.
   *
   * One statement rather than five round trips, and — more to the point —
   * one statement means there is no window in which the course exists and
   * the completion does not. A half-built approval would show the learner a
   * course at 0% that they cannot move and nobody can finish for them.
   *
   * The lesson's `content_type` is `external`, which is NOT in
   * `LESSON_CONTENT_TYPES`: nothing authors one of these by hand, exactly
   * like a session's companion lesson. The analytics mode-of-learning split
   * reads that column, so these hours report as their own mode rather than
   * quietly counting as a document.
   */
  async createCompanionCourse(input: {
    scope: OrgScope;
    certificationId: number;
    userId: number;
    approvedBy: number;
    courseName: string;
    authorizedBody: string;
    minutes: number;
  }): Promise<number> {
    const rows = await this.db.all<{ course_id: number }>(sql`
      WITH new_course AS (
        INSERT INTO courses
          (organization_id, name, description, is_active,
           external_certification_id, category)
        VALUES (${input.scope.organizationId},
                ${input.courseName},
                ${`Completed externally · awarded by ${input.authorizedBody}`},
                1, ${input.certificationId}, NULL)
        -- The unique index behind this is PARTIAL (0036 adds it WHERE
        -- external_certification_id IS NOT NULL, because every other course
        -- has NULL there and they must not collide). Postgres will not infer
        -- a partial index from the column alone -- it needs the same
        -- predicate spelled out here, or it refuses with "no unique or
        -- exclusion constraint matching the ON CONFLICT specification".
        -- courses.session_id gets away with a bare clause because ITS unique
        -- index is not partial.
        ON CONFLICT (external_certification_id)
          WHERE external_certification_id IS NOT NULL
          DO NOTHING
        RETURNING id
      ), new_module AS (
        INSERT INTO course_modules (organization_id, course_id, title, sort_order, is_active)
        SELECT ${input.scope.organizationId}, id, 'External certification', 0, 1
          FROM new_course
        RETURNING id, course_id
      ), new_lesson AS (
        INSERT INTO lessons
          (organization_id, course_id, module_id, title, description,
           content_type, duration_minutes, sort_order, is_preview, is_active)
        SELECT ${input.scope.organizationId}, course_id, id,
               ${input.courseName},
               ${`Awarded by ${input.authorizedBody}.`},
               ${EXTERNAL_LESSON_CONTENT_TYPE}, ${input.minutes}, 0, 0, 1
          FROM new_module
        RETURNING id, course_id
      ), new_assignment AS (
        INSERT INTO user_course_assignments
          (organization_id, user_id, course_id, assigned_by)
        SELECT ${input.scope.organizationId}, ${input.userId}, course_id,
               ${input.approvedBy}
          FROM new_lesson
        ON CONFLICT (user_id, course_id) DO NOTHING
        RETURNING course_id
      ), new_completion AS (
        INSERT INTO user_lesson_completions (organization_id, user_id, lesson_id)
        SELECT ${input.scope.organizationId}, ${input.userId}, id FROM new_lesson
        ON CONFLICT (user_id, lesson_id) DO NOTHING
        RETURNING lesson_id
      )
      SELECT course_id FROM new_lesson
    `);
    return rows[0]?.course_id ?? 0;
  }

  /** The learner's manager, and whether they can still act. Null when the
   *  learner has none, or theirs has been deactivated. */
  async activeManagerOf(
    scope: OrgScope,
    userId: number,
  ): Promise<{ id: number; name: string } | null> {
    const rows = await this.db.all<{ id: number; name: string }>(sql`
      SELECT m.id,
             TRIM(COALESCE(m.first_name, '') || ' ' || COALESCE(m.last_name, '')) AS name
        FROM users u
        JOIN users m ON m.id = u.manager_id
       WHERE u.id = ${userId}
         AND ${orgScope('u', scope)}
         AND m.is_active = 1
         AND ${orgScope('m', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }
}
