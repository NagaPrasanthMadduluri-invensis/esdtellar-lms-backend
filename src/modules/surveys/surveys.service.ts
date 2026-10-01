import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { COURSE_CATEGORIES } from '@/common/course-taxonomy';
import {
  DEFAULT_TEMPLATE_KEY,
  FEEDBACK_RATING_MAX,
  FEEDBACK_RATING_MIN,
  LIKERT_SCALE,
  MAX_TEMPLATE_QUESTIONS,
  SYSTEM_TEMPLATE_KEYS,
  isFeedbackQuestionType,
  templateKeyForCategory,
  type FeedbackQuestionType,
} from '@/common/feedback-questions';
import { actorLabel } from '@/common/notifications';
import type { AuthenticatedUser } from '@/common/types/authenticated-request';
import type { OrgScope } from '@/database/org-scope';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import type {
  SaveTemplateDto,
  SubmitCourseFeedbackDto,
  TemplateQuestionDto,
} from './dto/survey.dto';
import {
  SurveysRepository,
  type CourseFeedbackConfigRow,
  type QuestionRow,
  type TemplateRow,
} from './surveys.repository';

/** How a question is sent to either portal. snake_case, like the rows. */
export interface QuestionView {
  id: number;
  sort_order: number;
  question_type: FeedbackQuestionType;
  prompt: string;
  options: string[] | null;
  is_required: boolean;
}

export interface TemplateView {
  id: number;
  key: string;
  name: string;
  description: string | null;
  is_system: boolean;
  is_active: boolean;
  question_count: number;
  course_count: number;
  response_count: number;
  /** Which course categories fall to this template by default. */
  categories: string[];
  questions?: QuestionView[];
}

@Injectable()
export class SurveysService {
  constructor(
    private readonly repository: SurveysRepository,
    private readonly notifications: NotificationsService,
  ) {}

  /* ───────────────────────────── Admin side ──────────────────────────── */

  async listTemplates(scope: OrgScope) {
    const rows = await this.repository.listTemplates(scope);
    return { templates: rows.map((row) => this.shapeTemplate(row)) };
  }

  async getTemplate(scope: OrgScope, templateId: number) {
    const row = await this.repository.findTemplate(scope, templateId);
    if (!row) throw new NotFoundException('Feedback template not found');
    const questions = await this.repository.listQuestions(templateId);
    return {
      template: {
        ...this.shapeTemplate(row),
        questions: questions.map((q) => this.shapeQuestion(q)),
      },
    };
  }

  async createTemplate(scope: OrgScope, dto: SaveTemplateDto) {
    // Questions FIRST, before anything is written. `normaliseQuestions`
    // throws on a malformed one, and doing it after the insert left an empty
    // template behind every time an admin mistyped a choice list — the row
    // was created, the questions were refused, and the next attempt with the
    // same name silently got a `-2` key.
    const questions = this.normaliseQuestions(dto.questions ?? []);
    const key = await this.uniqueKey(scope, dto.name);
    const id = await this.repository.createTemplate(scope, {
      key,
      name: dto.name.trim(),
      description: dto.description ?? null,
    });
    await this.repository.replaceQuestions(id, questions);
    return this.getTemplate(scope, id);
  }

  /**
   * Rename, re-describe, deactivate and re-question in one call — the editor
   * holds the whole form and saves it whole.
   *
   * A SYSTEM template may be edited freely; only its `key` and its existence
   * are fixed, because the category resolver looks it up by key. That is the
   * whole point of the feature: the owner asked for templates the admin can
   * change, not three forms they can only read.
   */
  async updateTemplate(
    scope: OrgScope,
    templateId: number,
    dto: SaveTemplateDto,
  ) {
    const row = await this.repository.findTemplate(scope, templateId);
    if (!row) throw new NotFoundException('Feedback template not found');

    // A system template cannot be switched off: every course in its category
    // resolves to it, and "off" would leave them resolving to nothing with
    // nothing on screen saying why. Turning feedback off is a per-COURSE
    // control, which is where an admin would look for it.
    const isActive =
      row.is_system === 1 ? 1 : (dto.is_active ?? row.is_active === 1) ? 1 : 0;

    // Same order as `create`, and for the same reason: a refused question set
    // must not leave the name and description already renamed.
    const questions = dto.questions
      ? this.normaliseQuestions(dto.questions)
      : null;

    await this.repository.updateTemplate(scope, templateId, {
      name: dto.name.trim(),
      description: dto.description ?? null,
      isActive,
    });
    if (questions) {
      await this.repository.replaceQuestions(templateId, questions);
    }
    return this.getTemplate(scope, templateId);
  }

  async deleteTemplate(scope: OrgScope, templateId: number) {
    const row = await this.repository.findTemplate(scope, templateId);
    if (!row) throw new NotFoundException('Feedback template not found');
    if (row.is_system === 1) {
      throw new UnprocessableEntityException(
        'The standard, technical and compliance templates cannot be deleted — every course in their category resolves to them. Edit the questions instead, or turn feedback off on the courses you do not want it on.',
      );
    }
    await this.repository.deleteTemplate(scope, templateId);
    return {
      ok: true,
      /** Said back because it is not obvious from the button. */
      released_courses: row.course_count,
    };
  }

  /** Templates the course form may offer, plus the category mapping it shows. */
  async options(scope: OrgScope) {
    const [templates, byCourse] = await Promise.all([
      this.repository.listSelectable(scope),
      this.repository.responsesByCourse(scope),
    ]);

    /**
     * Which template each CATEGORY implies, resolved here and sent down.
     *
     * The course form needs it to say "Technical courses use the Technical
     * template" beside its override dropdown. Computing it in the browser
     * from a mirrored map would be a second copy of the resolution rule,
     * free to drift from the one that decides what a learner is actually
     * shown — so the rule stays in `templateKeyForCategory` and the answer
     * travels.
     */
    const byKey = new Map(templates.map((t) => [t.key, t]));
    const categoryTemplates: Record<
      string,
      { id: number; key: string; name: string } | null
    > = {};
    for (const category of COURSE_CATEGORIES) {
      const match = byKey.get(templateKeyForCategory(category));
      categoryTemplates[category] = match
        ? { id: match.id, key: match.key, name: match.name }
        : null;
    }

    return {
      templates: templates.map((t) => ({
        id: t.id,
        key: t.key,
        name: t.name,
        is_system: t.is_system === 1,
      })),
      category_templates: categoryTemplates,
      /** What a course with no category falls to. */
      default_template: byKey.get(DEFAULT_TEMPLATE_KEY)
        ? {
            id: byKey.get(DEFAULT_TEMPLATE_KEY)!.id,
            key: DEFAULT_TEMPLATE_KEY,
            name: byKey.get(DEFAULT_TEMPLATE_KEY)!.name,
          }
        : null,
      courses: byCourse,
    };
  }

  async listResponses(
    scope: OrgScope,
    filters: {
      courseId?: number;
      templateId?: number;
      limit: number;
      offset: number;
    },
  ) {
    const [rows, total] = await Promise.all([
      this.repository.listResponses(scope, filters),
      this.repository.countResponses(scope, filters),
    ]);

    // The questions behind every template these answers came from, resolved
    // in one pass rather than one read per response (§7.1). Without them the
    // admin sees a jsonb blob keyed by integers.
    const templateIds = [
      ...new Set(rows.map((r) => r.template_id).filter((id): id is number => !!id)),
    ];
    const questionsByTemplate = new Map<number, QuestionView[]>();
    await Promise.all(
      templateIds.map(async (id) => {
        const qs = await this.repository.listQuestions(id);
        questionsByTemplate.set(
          id,
          qs.map((q) => this.shapeQuestion(q)),
        );
      }),
    );

    return {
      responses: rows.map((row) => ({
        id: row.id,
        course_id: row.course_id,
        course_name: row.course_name,
        template_id: row.template_id,
        template_name: row.template_name,
        user_id: row.user_id,
        learner_name: row.learner_name || row.learner_email,
        learner_email: row.learner_email,
        department: row.department,
        submitted_at: toIso(row.created_at),
        answers: this.pairAnswers(
          row.answers,
          row.template_id ? (questionsByTemplate.get(row.template_id) ?? []) : [],
        ),
      })),
      total,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  /* ──────────────────────────── Learner side ─────────────────────────── */

  /**
   * The form for a course, and this learner's own answer if they have given
   * one. Returns `{ feedback: null }` when the course asks for none, which is
   * a real state the page renders as nothing rather than as an error.
   */
  async formForLearner(scope: OrgScope, courseId: number, userId: number) {
    const course = await this.repository.findCourseConfig(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');

    const assigned = await this.repository.learnerHasCourse(
      scope,
      courseId,
      userId,
    );
    if (!assigned) {
      throw new ForbiddenException('This course is not assigned to you');
    }

    const template = await this.resolveTemplate(scope, course);
    if (!template) return { feedback: null };

    const [questions, existing] = await Promise.all([
      this.repository.listQuestions(template.id),
      this.repository.findResponse(scope, courseId, userId),
    ]);

    return {
      feedback: {
        template_id: template.id,
        template_name: template.name,
        description: template.description,
        questions: questions.map((q) => this.shapeQuestion(q)),
        /**
         * What they saved last time, so revising starts from their answer
         * rather than from blank — the rule the session form already follows.
         */
        my_answers: existing?.answers ?? null,
        submitted_at: toIso(existing?.created_at ?? null),
      },
    };
  }

  /**
   * Save or revise. 200, not 201 — a learner correcting their own answer has
   * created nothing.
   *
   * NOTHING HERE TOUCHES COMPLETION. No lesson is marked, no certificate is
   * evaluated, no hours are credited. That is the owner's rule and it is
   * enforced by this method doing none of those things rather than by a flag
   * somewhere deciding not to.
   */
  async submit(
    scope: OrgScope,
    courseId: number,
    user: AuthenticatedUser,
    dto: SubmitCourseFeedbackDto,
  ) {
    const course = await this.repository.findCourseConfig(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');

    const assigned = await this.repository.learnerHasCourse(
      scope,
      courseId,
      user.userId,
    );
    if (!assigned) {
      throw new ForbiddenException('This course is not assigned to you');
    }

    const template = await this.resolveTemplate(scope, course);
    if (!template) {
      throw new UnprocessableEntityException(
        'This course is not asking for feedback',
      );
    }

    const questions = await this.repository.listQuestions(template.id);
    const answers = this.validateAnswers(questions, dto.answers);

    const { created } = await this.repository.upsertResponse({
      scope,
      courseId,
      userId: user.userId,
      templateId: template.id,
      answers,
    });

    // First submission only. Best-effort (§8.4) — a bell that did not ring
    // must never cost a learner their answer.
    if (created) {
      void this.notifyAdmins(scope, course, user);
    }

    return { ok: true, created, submitted_at: new Date().toISOString() };
  }

  /* ──────────────────────────── Resolution ───────────────────────────── */

  /**
   * Which form a course shows, or null for none. The one place the rule
   * lives, read by the learner's form, the learner's submit and the admin's
   * course page — so the three cannot disagree about which questions a
   * learner will be asked.
   *
   *   feedback_enabled = 0      -> none
   *   feedback_template_id set  -> that one, whatever the category says
   *   otherwise                 -> the category's, falling back to standard
   *
   * A session's companion training is excluded: a session is rated through
   * `session_feedback` (0032), by the three fixed questions its trainer
   * reads, and offering a learner two forms for one sitting would collect
   * two half-answered ones.
   */
  private async resolveTemplate(
    scope: OrgScope,
    course: CourseFeedbackConfigRow,
  ): Promise<TemplateRow | null> {
    if (course.feedback_enabled !== 1) return null;
    if (course.session_id !== null) return null;

    if (course.feedback_template_id) {
      const explicit = await this.repository.findTemplate(
        scope,
        course.feedback_template_id,
      );
      // A template deleted out from under a course drops it back to the
      // category default rather than to nothing — ON DELETE SET NULL already
      // does that in the database; this covers the window where the id names
      // a template in another tenant, which is not this course's to show.
      if (explicit && explicit.is_active === 1) return explicit;
    }

    const byCategory = await this.repository.findTemplateByKey(
      scope,
      templateKeyForCategory(course.category),
    );
    if (byCategory && byCategory.is_active === 1) return byCategory;

    // Every tenant is seeded with `standard`, so this is only reached if an
    // admin deactivated it — in which case no feedback is the honest answer.
    return null;
  }

  /**
   * The SAME rule as `resolveTemplate`, applied against a template list that
   * is already in hand.
   *
   * It exists so a LIST of courses can be resolved without a query per row
   * (§7.1). `resolveTemplate` above reads one course's templates from the
   * database; this reads them from a map the caller loaded once. Both must
   * agree, which is why the branches below are the same three in the same
   * order — if one changes, change both, or the dashboard will offer a form
   * the course page does not.
   */
  private pickTemplate(
    templates: TemplateRow[],
    course: {
      feedback_enabled: number;
      session_id: number | null;
      feedback_template_id: number | null;
      category: string | null;
    },
  ): TemplateRow | null {
    if (course.feedback_enabled !== 1) return null;
    if (course.session_id !== null) return null;

    if (course.feedback_template_id) {
      const explicit = templates.find(
        (t) => t.id === course.feedback_template_id,
      );
      if (explicit && explicit.is_active === 1) return explicit;
    }

    const key = templateKeyForCategory(course.category);
    const byCategory = templates.find((t) => t.key === key);
    return byCategory && byCategory.is_active === 1 ? byCategory : null;
  }

  /**
   * Courses this learner has FINISHED and not yet rated — the dashboard's
   * "your feedback is wanted" prompt.
   *
   * Completed only, deliberately. A learner may rate a course at any point
   * from its own page, but prompting somebody for an opinion on training
   * they are 20% through is asking a question they cannot answer, and a
   * dashboard panel full of those is one people stop reading.
   *
   * Two queries whatever the size of the list: the candidates, and the org's
   * templates. The resolution then happens in memory through `pickTemplate`,
   * so a learner with twelve finished courses still costs two round trips.
   */
  async pendingForLearner(scope: OrgScope, userId: number) {
    const { pending } = await this.listForLearner(scope, userId);
    return { surveys: pending };
  }

  /**
   * Everything this learner has been asked to say about a COURSE, split into
   * what is still owed and what they have already sent.
   *
   * ONE query for both halves, then one split. The dashboard panel reads the
   * pending side through `pendingForLearner` above, which is now a view over
   * this rather than its own query — so the panel and the Surveys module can
   * never disagree about whether a form is outstanding.
   *
   * Session feedback is NOT here. It is a different table with different
   * questions and a different audience (§10.24), and it is served by
   * `FeedbackService`; the Surveys page reads both and shows them side by
   * side rather than this method pretending to own both.
   */
  async listForLearner(scope: OrgScope, userId: number) {
    const [candidates, templates] = await Promise.all([
      this.repository.feedbackCoursesForLearner(scope, userId),
      this.repository.listTemplates(scope),
    ]);

    const shaped = candidates
      .map((row) => ({ row, template: this.pickTemplate(templates, row) }))
      .filter(
        (x): x is { row: (typeof candidates)[number]; template: TemplateRow } =>
          x.template !== null,
      )
      .map(({ row, template }) => ({
        course_id: row.id,
        course_name: row.name,
        category: row.category,
        thumbnail_url: row.thumbnail_url,
        completed_at: toIso(row.completed_at),
        answered_at: toIso(row.answered_at),
        template_id: template.id,
        template_name: template.name,
        question_count: template.question_count,
      }));

    return {
      pending: shaped.filter((r) => r.answered_at === null),
      // Newest answer first: the thing somebody scrolls to check is what
      // they said most recently.
      submitted: shaped
        .filter((r) => r.answered_at !== null)
        .sort((a, b) => String(b.answered_at).localeCompare(String(a.answered_at))),
    };
  }

  /**
   * The template a course would use, for the admin's course form. Returns the
   * category default and the override separately, because the form shows
   * "Technical courses use the Technical template" beside a dropdown that can
   * change it — and it has to be able to say which of the two is in force.
   */
  async templateForCourse(scope: OrgScope, courseId: number) {
    const course = await this.repository.findCourseConfig(scope, courseId);
    if (!course) throw new NotFoundException('Course not found');
    const resolved = await this.resolveTemplate(scope, course);
    const byCategory = await this.repository.findTemplateByKey(
      scope,
      templateKeyForCategory(course.category),
    );
    return {
      feedback_enabled: course.feedback_enabled === 1,
      override_template_id: course.feedback_template_id,
      category_template: byCategory
        ? { id: byCategory.id, key: byCategory.key, name: byCategory.name }
        : null,
      resolved_template: resolved
        ? { id: resolved.id, key: resolved.key, name: resolved.name }
        : null,
    };
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  /** Which categories fall to a template by default — shown on its card so an
   *  admin knows what they are editing before they edit it. */
  private categoriesFor(key: string): string[] {
    if (key === 'technical') return ['Technical'];
    if (key === 'compliance') return ['Compliance'];
    if (key === 'standard') return ['Every other category'];
    return [];
  }

  private shapeTemplate(row: TemplateRow): TemplateView {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      is_system: row.is_system === 1,
      is_active: row.is_active === 1,
      question_count: row.question_count,
      course_count: row.course_count,
      response_count: row.response_count,
      categories: this.categoriesFor(row.key),
    };
  }

  private shapeQuestion(row: QuestionRow): QuestionView {
    return {
      id: row.id,
      sort_order: row.sort_order,
      question_type: (isFeedbackQuestionType(row.question_type)
        ? row.question_type
        : 'text') as FeedbackQuestionType,
      prompt: row.prompt,
      options: Array.isArray(row.options) ? row.options : null,
      is_required: row.is_required === 1,
    };
  }

  /**
   * Trim, renumber and clean the incoming question set.
   *
   * `options` is stripped from every type that does not use it, rather than
   * stored and ignored: a list the learner will never see is a field that
   * lies about what the form does, and the next person to read the row would
   * have no way to tell which was true.
   */
  private normaliseQuestions(questions: TemplateQuestionDto[]) {
    if (questions.length > MAX_TEMPLATE_QUESTIONS) {
      throw new UnprocessableEntityException(
        `questions must be ${MAX_TEMPLATE_QUESTIONS} or fewer`,
      );
    }
    return questions.map((q, index) => {
      if (!isFeedbackQuestionType(q.question_type)) {
        throw new BadRequestException(
          `question_type "${q.question_type}" is not a feedback question type`,
        );
      }
      const optionBacked = q.question_type === 'choice';
      const options = (q.options ?? [])
        .map((o) => String(o).trim())
        .filter(Boolean);
      if (optionBacked && options.length < 2) {
        throw new UnprocessableEntityException(
          `options: "${q.prompt.slice(0, 40)}" is a multiple choice question and needs at least two choices`,
        );
      }
      // An open text question is never required. A mandatory essay is how a
      // form gets abandoned, and an abandoned form collects nothing at all.
      const isRequired = q.question_type === 'text' ? false : !!q.is_required;
      return {
        sortOrder: index + 1,
        questionType: q.question_type,
        prompt: q.prompt.trim(),
        options: optionBacked ? options : null,
        isRequired,
      };
    });
  }

  /**
   * Check the learner's answers against the questions they were shown, and
   * keep ONLY answers to real questions.
   *
   * The whitelist matters more than the type checks: `answers` is a jsonb
   * document written from a request body, so without it a caller could store
   * arbitrary keys of arbitrary size in a column nothing validates.
   */
  private validateAnswers(
    questions: QuestionRow[],
    incoming: Record<string, unknown>,
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    const missing: string[] = [];

    for (const raw of questions) {
      const q = this.shapeQuestion(raw);
      const value = incoming[String(q.id)];
      const blank =
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '');

      if (blank) {
        if (q.is_required) missing.push(q.prompt);
        continue;
      }

      switch (q.question_type) {
        case 'rating': {
          const n = Number(value);
          if (
            !Number.isInteger(n) ||
            n < FEEDBACK_RATING_MIN ||
            n > FEEDBACK_RATING_MAX
          ) {
            throw new UnprocessableEntityException(
              `answers: "${q.prompt}" must be a rating from ${FEEDBACK_RATING_MIN} to ${FEEDBACK_RATING_MAX}`,
            );
          }
          clean[String(q.id)] = n;
          break;
        }
        case 'likert': {
          const s = String(value);
          if (!LIKERT_SCALE.includes(s as (typeof LIKERT_SCALE)[number])) {
            throw new UnprocessableEntityException(
              `answers: "${q.prompt}" must be one of: ${LIKERT_SCALE.join(', ')}`,
            );
          }
          clean[String(q.id)] = s;
          break;
        }
        case 'choice': {
          const s = String(value);
          if (!(q.options ?? []).includes(s)) {
            throw new UnprocessableEntityException(
              `answers: "${q.prompt}" must be one of the offered choices`,
            );
          }
          clean[String(q.id)] = s;
          break;
        }
        case 'yesno': {
          const s = String(value).toLowerCase();
          if (s !== 'yes' && s !== 'no') {
            throw new UnprocessableEntityException(
              `answers: "${q.prompt}" must be yes or no`,
            );
          }
          clean[String(q.id)] = s === 'yes' ? 'Yes' : 'No';
          break;
        }
        case 'text': {
          const s = String(value).trim().slice(0, TEXT_ANSWER_MAX);
          clean[String(q.id)] = s;
          break;
        }
      }
    }

    if (missing.length > 0) {
      throw new UnprocessableEntityException(
        `answers: please answer "${missing[0]}"${
          missing.length > 1 ? ` and ${missing.length - 1} more` : ''
        }`,
      );
    }
    return clean;
  }

  /** Pair stored answers with the wording they were given, for the admin.
   *  An answer whose question has since been rewritten or removed is listed
   *  as an orphan rather than re-labelled — re-labelling would put words in
   *  somebody's mouth. */
  private pairAnswers(
    answers: Record<string, unknown>,
    questions: QuestionView[],
  ) {
    const paired = questions.map((q) => ({
      question_id: q.id,
      prompt: q.prompt,
      question_type: q.question_type,
      answer: answers[String(q.id)] ?? null,
    }));
    const known = new Set(questions.map((q) => String(q.id)));
    const orphans = Object.entries(answers)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => ({
        question_id: Number(key),
        prompt: 'A question that has since been changed',
        question_type: 'text' as FeedbackQuestionType,
        answer: value,
      }));
    return [...paired, ...orphans];
  }

  /**
   * A key that is unique in this org. Derived from the name, never typed —
   * an admin should not have to know that a key exists, and the three system
   * keys must stay reachable by the category resolver.
   */
  private async uniqueKey(scope: OrgScope, name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'template';
    const reserved = new Set<string>(SYSTEM_TEMPLATE_KEYS);
    let candidate = reserved.has(base) ? `${base}-custom` : base;
    for (let n = 2; await this.repository.keyExists(scope, candidate); n += 1) {
      candidate = `${base}-${n}`;
      if (n > 50) throw new UnprocessableEntityException('name: pick another name');
    }
    return candidate;
  }

  private async notifyAdmins(
    scope: OrgScope,
    course: CourseFeedbackConfigRow,
    user: AuthenticatedUser,
  ) {
    const admins = await this.notifications.adminsOf(scope.organizationId);
    await this.notifications.notify({
      userIds: admins,
      organizationId: scope.organizationId,
      type: 'course_feedback_received',
      title: 'New course feedback',
      body: `${actorLabel(user)} gave feedback on ${course.name}.`,
      link: `/admin/surveys?course=${course.id}`,
      subjectType: 'course',
      subjectId: course.id,
      actorName: actorLabel(user),
      exceptUserId: user.userId,
    });
  }
}

/**
 * A Postgres timestamp is NOT an ISO string: `2026-09-28 10:29:02.9+00` has a
 * space instead of the `T` and a two-digit offset, and `new Date()` rejects
 * both. Every date this module sends is converted here rather than left for
 * each caller to patch up — TASTE §10.3.1.15 records a whole column of `—`
 * that this exact value produced on a screen that was being sent real dates.
 */
function toIso(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value.replace(' ', 'T').replace(/\+(\d\d)$/, '+$1:00'));
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** A free answer is capped at the same order as every other free-text field.
 *  Long enough for a paragraph, short enough that a jsonb document cannot be
 *  used as storage. */
const TEXT_ANSWER_MAX = 1000;
