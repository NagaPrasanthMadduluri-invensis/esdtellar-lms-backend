import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';
import { feedbackTemplateQuestions } from '@/database/schema';

/**
 * Every query over the course-feedback tables.
 *
 * RAW SQL THROUGHOUT for the reads, and every row shape below is snake_case.
 * §10.10 records this defect seven times: a repository that mixes Drizzle
 * `.select()` (camelCase) with raw SQL (snake_case) hands two different key
 * sets for the same row depending on which method produced it. The two writes
 * that use the query builder (`replaceQuestions`, in a transaction) return
 * nothing, so there is no shape to disagree about.
 *
 * TWO SCOPES, AND THE DIFFERENCE MATTERS HERE MORE THAN USUAL:
 *
 *   - a TEMPLATE is per-tenant data, always `orgScope`. There is deliberately
 *     no platform-owned template: the whole point is that an admin may edit
 *     the wording, and a shared row would mean one org rewriting everybody's
 *     form.
 *   - a RESPONSE is ACTIVITY, so `orgScope` too — even though the COURSE it
 *     is about may be platform-owned and shared. That is exactly the class of
 *     bug §10.12 records: the content predicate says whether this admin may
 *     see the course, and nothing at all about whose opinion is being counted
 *     against it.
 */

/** A template row as the admin list returns it. */
export interface TemplateRow {
  id: number;
  organization_id: number;
  key: string;
  name: string;
  description: string | null;
  is_system: number;
  is_active: number;
  question_count: number;
  course_count: number;
  response_count: number;
  created_at: string;
  updated_at: string;
}

export interface QuestionRow {
  id: number;
  template_id: number;
  sort_order: number;
  question_type: string;
  prompt: string;
  options: string[] | null;
  is_required: number;
}

export interface ResponseRow {
  id: number;
  course_id: number;
  course_name: string;
  template_id: number | null;
  template_name: string | null;
  user_id: number;
  learner_name: string;
  learner_email: string;
  department: string | null;
  answers: Record<string, unknown>;
  created_at: string;
}

/** What the resolver needs to decide which form a course shows. */
export interface CourseFeedbackConfigRow {
  id: number;
  name: string;
  category: string | null;
  session_id: number | null;
  feedback_enabled: number;
  feedback_template_id: number | null;
}

@Injectable()
export class SurveysRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /* ───────────────────────────── Templates ───────────────────────────── */

  /**
   * Every template in the org, with three correlated counts.
   *
   * Counts in SQL, not a follow-up query per template (§7.1/§7.2) — the page
   * shows all three on every card and a list of six templates must still cost
   * one round trip.
   */
  async listTemplates(scope: OrgScope): Promise<TemplateRow[]> {
    return this.db.all<TemplateRow>(sql`
      SELECT ft.id,
             ft.organization_id,
             ft.key,
             ft.name,
             ft.description,
             ft.is_system,
             ft.is_active,
             (SELECT COUNT(*)::int FROM feedback_template_questions q
               WHERE q.template_id = ft.id)              AS question_count,
             (SELECT COUNT(*)::int FROM courses c
               WHERE c.feedback_template_id = ft.id)     AS course_count,
             (SELECT COUNT(*)::int FROM course_feedback cf
               WHERE cf.template_id = ft.id
                 AND ${orgScope('cf', scope)})           AS response_count,
             ft.created_at,
             ft.updated_at
        FROM feedback_templates ft
       WHERE ${orgScope('ft', scope)}
       ORDER BY ft.is_system DESC, ft.id
    `);
  }

  async findTemplate(
    scope: OrgScope,
    templateId: number,
  ): Promise<TemplateRow | null> {
    const rows = await this.db.all<TemplateRow>(sql`
      SELECT ft.id, ft.organization_id, ft.key, ft.name, ft.description,
             ft.is_system, ft.is_active,
             (SELECT COUNT(*)::int FROM feedback_template_questions q
               WHERE q.template_id = ft.id)          AS question_count,
             (SELECT COUNT(*)::int FROM courses c
               WHERE c.feedback_template_id = ft.id) AS course_count,
             (SELECT COUNT(*)::int FROM course_feedback cf
               WHERE cf.template_id = ft.id
                 AND ${orgScope('cf', scope)})       AS response_count,
             ft.created_at, ft.updated_at
        FROM feedback_templates ft
       WHERE ft.id = ${templateId} AND ${orgScope('ft', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** The org's template with this key, or null. How a CATEGORY resolves. */
  async findTemplateByKey(
    scope: OrgScope,
    key: string,
  ): Promise<TemplateRow | null> {
    const rows = await this.db.all<TemplateRow>(sql`
      SELECT ft.id, ft.organization_id, ft.key, ft.name, ft.description,
             ft.is_system, ft.is_active,
             0 AS question_count, 0 AS course_count, 0 AS response_count,
             ft.created_at, ft.updated_at
        FROM feedback_templates ft
       WHERE ft.key = ${key} AND ${orgScope('ft', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Does this org already use this key? Checked before insert so the caller
   *  gets a sentence rather than a constraint violation. */
  async keyExists(scope: OrgScope, key: string): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM feedback_templates ft
       WHERE ft.key = ${key} AND ${orgScope('ft', scope)}
    `);
    return (rows[0]?.n ?? 0) > 0;
  }

  async listQuestions(templateId: number): Promise<QuestionRow[]> {
    return this.db.all<QuestionRow>(sql`
      SELECT id, template_id, sort_order, question_type, prompt, options, is_required
        FROM feedback_template_questions
       WHERE template_id = ${templateId}
       ORDER BY sort_order, id
    `);
  }

  async createTemplate(
    scope: OrgScope,
    input: { key: string; name: string; description: string | null },
  ): Promise<number> {
    const rows = await this.db.all<{ id: number }>(sql`
      INSERT INTO feedback_templates (organization_id, key, name, description, is_system)
      VALUES (${scope.organizationId}, ${input.key}, ${input.name}, ${input.description}, 0)
      RETURNING id
    `);
    return rows[0].id;
  }

  async updateTemplate(
    scope: OrgScope,
    templateId: number,
    patch: { name: string; description: string | null; isActive: number },
  ): Promise<void> {
    await this.db.run(sql`
      UPDATE feedback_templates ft
         SET name = ${patch.name},
             description = ${patch.description},
             is_active = ${patch.isActive},
             updated_at = now()
       WHERE ft.id = ${templateId} AND ${orgScope('ft', scope)}
    `);
  }

  /**
   * Replace the whole question set in one transaction: delete, then one
   * multi-row insert (§7.1). The editor always resends the complete ordered
   * list, so a diff would be a slower route to the same rows.
   *
   * The delete cascades nothing — `course_feedback.answers` is keyed by the
   * OLD question ids and keeps them. That is the documented cost of a jsonb
   * answer document: an answer whose question has been rewritten is read back
   * as an orphan rather than silently re-labelled with the new wording, which
   * would put words in a learner's mouth.
   */
  async replaceQuestions(
    templateId: number,
    questions: {
      sortOrder: number;
      questionType: string;
      prompt: string;
      options: string[] | null;
      isRequired: boolean;
    }[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(feedbackTemplateQuestions)
        .where(sql`${feedbackTemplateQuestions.templateId} = ${templateId}`);
      if (questions.length === 0) return;
      await tx.insert(feedbackTemplateQuestions).values(
        questions.map((q) => ({
          templateId,
          sortOrder: q.sortOrder,
          questionType: q.questionType,
          prompt: q.prompt,
          options: q.options,
          isRequired: q.isRequired ? 1 : 0,
        })),
      );
    });
    await this.db.run(sql`
      UPDATE feedback_templates SET updated_at = now() WHERE id = ${templateId}
    `);
  }

  /** Courses pointing at this template drop back to their category default
   *  (ON DELETE SET NULL), and responses keep their answers (also SET NULL). */
  async deleteTemplate(scope: OrgScope, templateId: number): Promise<void> {
    await this.db.run(sql`
      DELETE FROM feedback_templates ft
       WHERE ft.id = ${templateId} AND ${orgScope('ft', scope)}
    `);
  }

  /** Templates the admin's course form may offer: this org's active ones. */
  async listSelectable(scope: OrgScope): Promise<
    { id: number; key: string; name: string; is_system: number }[]
  > {
    return this.db.all<{
      id: number;
      key: string;
      name: string;
      is_system: number;
    }>(sql`
      SELECT ft.id, ft.key, ft.name, ft.is_system
        FROM feedback_templates ft
       WHERE ${orgScope('ft', scope)} AND ft.is_active = 1
       ORDER BY ft.is_system DESC, ft.name
    `);
  }

  /* ───────────────────────────── The course ──────────────────────────── */

  /**
   * The course's feedback configuration.
   *
   * `contentScope` on the course itself, because a platform-owned course IS
   * visible to the tenant and its learners must be able to rate it — the same
   * widening the certificate reads needed.
   */
  async findCourseConfig(
    scope: OrgScope,
    courseId: number,
  ): Promise<CourseFeedbackConfigRow | null> {
    const rows = await this.db.all<CourseFeedbackConfigRow>(sql`
      SELECT c.id, c.name, c.category, c.session_id,
             c.feedback_enabled, c.feedback_template_id
        FROM courses c
       WHERE c.id = ${courseId}
         AND c.organization_id IN (${scope.organizationId}, ${scope.platformOrganizationId})
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /** Is this course assigned to this learner? Their entitlement to rate it. */
  async learnerHasCourse(
    scope: OrgScope,
    courseId: number,
    userId: number,
  ): Promise<boolean> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM user_course_assignments uca
       WHERE uca.course_id = ${courseId}
         AND uca.user_id = ${userId}
         AND ${orgScope('uca', scope)}
    `);
    return (rows[0]?.n ?? 0) > 0;
  }

  /* ──────────────────────────── Responses ────────────────────────────── */

  /**
   * One learner's own answer, for re-opening the form on what they actually
   * saved rather than on blank.
   */
  async findResponse(
    scope: OrgScope,
    courseId: number,
    userId: number,
  ): Promise<{
    id: number;
    template_id: number | null;
    answers: Record<string, unknown>;
    created_at: string;
  } | null> {
    const rows = await this.db.all<{
      id: number;
      template_id: number | null;
      answers: Record<string, unknown>;
      created_at: string;
    }>(sql`
      SELECT cf.id, cf.template_id, cf.answers, cf.created_at
        FROM course_feedback cf
       WHERE cf.course_id = ${courseId}
         AND cf.user_id = ${userId}
         AND ${orgScope('cf', scope)}
       LIMIT 1
    `);
    return rows[0] ?? null;
  }

  /**
   * Upsert. Returns whether the row was NEW — the caller notifies only on a
   * first submission, because an admin whose bell rang on every edit would
   * learn to ignore it (§10.18).
   */
  async upsertResponse(input: {
    scope: OrgScope;
    courseId: number;
    userId: number;
    templateId: number | null;
    answers: Record<string, unknown>;
  }): Promise<{ id: number; created: boolean }> {
    const rows = await this.db.all<{ id: number; created: boolean }>(sql`
      INSERT INTO course_feedback (organization_id, course_id, user_id, template_id, answers)
      VALUES (${input.scope.organizationId}, ${input.courseId}, ${input.userId},
              ${input.templateId}, ${JSON.stringify(input.answers)}::jsonb)
      ON CONFLICT (course_id, user_id) DO UPDATE
            SET answers = EXCLUDED.answers,
                template_id = EXCLUDED.template_id
      RETURNING id, (xmax = 0) AS created
    `);
    return rows[0];
  }

  /**
   * The admin's responses list. Names the author — the owner's rule is
   * "anonymous to everyone except the admin", and this is the only read that
   * selects `user_id`.
   */
  async listResponses(
    scope: OrgScope,
    filters: {
      courseId?: number;
      templateId?: number;
      limit: number;
      offset: number;
    },
  ): Promise<ResponseRow[]> {
    return this.db.all<ResponseRow>(sql`
      SELECT cf.id,
             cf.course_id,
             c.name  AS course_name,
             cf.template_id,
             ft.name AS template_name,
             cf.user_id,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS learner_name,
             u.email AS learner_email,
             u.department,
             cf.answers,
             cf.created_at
        FROM course_feedback cf
        JOIN courses c ON c.id = cf.course_id
        JOIN users u   ON u.id = cf.user_id
   LEFT JOIN feedback_templates ft ON ft.id = cf.template_id
       WHERE ${orgScope('cf', scope)}
         ${this.optionalEq('cf.course_id', filters.courseId)}
         ${this.optionalEq('cf.template_id', filters.templateId)}
       ORDER BY cf.created_at DESC
       LIMIT ${filters.limit} OFFSET ${filters.offset}
    `);
  }

  async countResponses(
    scope: OrgScope,
    filters: { courseId?: number; templateId?: number },
  ): Promise<number> {
    const rows = await this.db.all<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM course_feedback cf
       WHERE ${orgScope('cf', scope)}
         ${this.optionalEq('cf.course_id', filters.courseId)}
         ${this.optionalEq('cf.template_id', filters.templateId)}
    `);
    return rows[0]?.n ?? 0;
  }

  /**
   * Courses that have at least one response, with how many — the filter the
   * admin page's course dropdown offers. Reduced from the same table the
   * list reads, so the dropdown cannot name a course with nothing behind it.
   */
  async responsesByCourse(
    scope: OrgScope,
  ): Promise<{ course_id: number; course_name: string; responses: number }[]> {
    return this.db.all<{
      course_id: number;
      course_name: string;
      responses: number;
    }>(sql`
      SELECT cf.course_id, c.name AS course_name, COUNT(*)::int AS responses
        FROM course_feedback cf
        JOIN courses c ON c.id = cf.course_id
       WHERE ${orgScope('cf', scope)}
       GROUP BY cf.course_id, c.name
       ORDER BY responses DESC, c.name
    `);
  }

  /** `AND <col> = <value>`, or nothing. Keeps the three filtered reads above
   *  from each growing their own branch of string building. */
  private optionalEq(column: string, value: number | undefined): SQL {
    if (value === undefined) return sql``;
    const [table, col] = column.split('.');
    return sql` AND ${sql.identifier(table)}.${sql.identifier(col)} = ${value}`;
  }
}
