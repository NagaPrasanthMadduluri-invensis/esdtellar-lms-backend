import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { OrgScope } from '@/database/org-scope';
import { CertificatesService } from '@/modules/certificates/certificates.service';

import { AssessmentsRepository } from './assessments.repository';
import type {
  AssessmentDto,
  QuestionDto,
  SubmitAttemptDto,
} from './dto/assessment.dto';

@Injectable()
export class AssessmentsService {
  constructor(
    private readonly repository: AssessmentsRepository,
    private readonly certificates: CertificatesService,
  ) {}

  /* ── Admin ── */

  async listAll(scope: OrgScope) {
    const rows = (await this.repository.listAll(scope)) as Record<string, unknown>[];
    return {
      assessments: rows.map((row) => ({
        ...row,
        is_active: Number(row.is_active) === 1,
      })),
    };
  }

  async listByCourse(scope: OrgScope, courseId: number) {
    return { assessments: await this.repository.listByCourse(scope, courseId) };
  }

  async create(scope: OrgScope, courseId: number, dto: AssessmentDto) {
    // A foreign course id must 404 rather than let an assessment be created
    // that claims this org while pointing at another org's course (§5.3).
    if (!(await this.repository.courseExists(scope, courseId))) {
      throw new NotFoundException('Course not found');
    }

    const assessment = await this.repository.createAssessment({
      organizationId: scope.organizationId,
      courseId,
      title: dto.title,
      description: dto.description ?? null,
      passingScore: dto.passing_score ?? 60,
    });
    return { assessment };
  }

  /**
   * Attach/detach. Detaching hides the assessment from learners and stops new
   * attempts, but past attempts stay in the admin reports — and because course
   * completion keys off attached assessments, detaching one can make a course
   * completable that was not before.
   */
  async setAttached(scope: OrgScope, assessmentId: number, attached: boolean) {
    const assessment = await this.repository.setAttached(scope, assessmentId, attached);
    if (!assessment) throw new NotFoundException('Assessment not found');
    return { assessment, attached };
  }

  async update(scope: OrgScope, assessmentId: number, dto: AssessmentDto) {
    const current = await this.repository.findById(scope, assessmentId);
    if (!current) throw new NotFoundException('Assessment not found');

    const assessment = await this.repository.updateAssessment(scope, assessmentId, {
      title: dto.title,
      description: dto.description ?? null,
      passingScore: dto.passing_score ?? 60,
      // Omitted means "leave the attachment alone" — editing a title must not
      // detach a live assessment as a side effect.
      isActive:
        dto.is_active === undefined
          ? current.isActive === 1
          : Boolean(dto.is_active),
    });
    if (!assessment) throw new NotFoundException('Assessment not found');
    return { assessment };
  }

  async remove(scope: OrgScope, assessmentId: number) {
    await this.repository.deleteAssessment(scope, assessmentId);
    return { message: 'Assessment deleted' };
  }

  /** Admin view — includes the answer key. */
  async getForAdmin(scope: OrgScope, assessmentId: number) {
    const assessment = await this.repository.findById(scope, assessmentId);
    if (!assessment) throw new NotFoundException('Assessment not found');

    const [questions, options] = await Promise.all([
      this.repository.listQuestions(scope, assessmentId),
      this.repository.listOptionsForAssessment(scope, assessmentId, true),
    ]);

    return {
      assessment,
      questions: this.attachOptions(questions, options),
    };
  }

  async addQuestion(scope: OrgScope, assessmentId: number, dto: QuestionDto) {
    // A foreign assessment id must 404 rather than let a question be created
    // against it (§5.3).
    const assessment = await this.repository.findById(scope, assessmentId);
    if (!assessment) throw new NotFoundException('Assessment not found');

    this.assertHasCorrectOption(dto);

    const sortOrder = await this.repository.nextQuestionSortOrder(
      scope,
      assessmentId,
    );
    const question = await this.repository.createQuestion({
      organizationId: scope.organizationId,
      assessmentId,
      questionText: dto.question_text,
      marks: dto.marks || 1,
      sortOrder,
    });

    await this.repository.replaceOptions(scope, question.id, dto.options);

    return {
      question: {
        ...question,
        options: await this.repository.listOptionsForQuestion(scope, question.id),
      },
    };
  }

  async updateQuestion(scope: OrgScope, questionId: number, dto: QuestionDto) {
    this.assertHasCorrectOption(dto);

    const question = await this.repository.updateQuestion(scope, questionId, {
      questionText: dto.question_text,
      marks: dto.marks || 1,
    });
    if (!question) throw new NotFoundException('Question not found');

    await this.repository.replaceOptions(scope, questionId, dto.options);

    return {
      question: {
        ...question,
        options: await this.repository.listOptionsForQuestion(scope, questionId),
      },
    };
  }

  async removeQuestion(scope: OrgScope, questionId: number) {
    await this.repository.deleteQuestion(scope, questionId);
    return { message: 'Question deleted' };
  }

  /* ── Learner ── */

  async listForLearner(scope: OrgScope, userId: number) {
    const [rows, attempts] = await Promise.all([
      this.repository.listForLearner(scope, userId),
      this.repository.attemptsForLearner(scope, userId),
    ]);

    const attemptsByAssessment = new Map<number, typeof attempts>();
    for (const attempt of attempts) {
      const key = Number(attempt.assessment_id);
      const list = attemptsByAssessment.get(key);
      if (list) list.push(attempt);
      else attemptsByAssessment.set(key, [attempt]);
    }

    return {
      assessments: rows.map((row) => {
        const own = attemptsByAssessment.get(Number(row.id)) ?? [];
        const totalLessons = Number(row.total_lessons);
        const completedLessons = Number(row.completed_lessons);

        return {
          id: row.id,
          title: row.title,
          description: row.description,
          passing_score: row.passing_score,
          questions_count: Number(row.questions_count),
          attempt_count: Number(row.attempt_count),
          best_score: row.best_score !== null ? Number(row.best_score) : null,
          course_id: row.course_id,
          course_name: row.course_name,
          // An assessment unlocks only once every lesson in the course is done.
          is_unlocked: totalLessons > 0 && completedLessons === totalLessons,
          has_passed: own.some((attempt) => Number(attempt.is_passed) === 1),
          last_attempt: own[0] ?? null,
          attempts: own,
        };
      }),
    };
  }

  /** Learner view — options are returned WITHOUT the answer key. */
  async getForLearner(scope: OrgScope, assessmentId: number, userId: number) {
    const assessment = await this.repository.findActiveWithCourse(
      scope,
      assessmentId,
    );
    if (!assessment) throw new NotFoundException('Assessment not found');

    await this.assertAssigned(scope, userId, Number(assessment.course_id));

    const [questions, options, attemptCount] = await Promise.all([
      this.repository.listQuestions(scope, assessmentId),
      this.repository.listOptionsForAssessment(scope, assessmentId, false),
      this.repository.countAttempts(scope, userId, assessmentId),
    ]);

    return {
      assessment,
      questions: this.attachOptions(questions, options),
      attempt_count: attemptCount,
    };
  }

  async listAttempts(scope: OrgScope, assessmentId: number, userId: number) {
    return {
      attempts: await this.repository.attemptsFor(scope, userId, assessmentId),
    };
  }

  /** Grades server-side against the stored answer key. */
  async submitAttempt(
    scope: OrgScope,
    assessmentId: number,
    userId: number,
    dto: SubmitAttemptDto,
  ) {
    const assessment = await this.repository.findActiveWithCourse(
      scope,
      assessmentId,
    );
    if (!assessment) throw new NotFoundException('Assessment not found');

    const courseId = Number(assessment.course_id);
    await this.assertAssigned(scope, userId, courseId);

    const key = await this.repository.answerKey(scope, assessmentId);

    let score = 0;
    const scored = dto.answers.map((answer) => {
      const question = key.find((q) => Number(q.id) === answer.question_id);
      const isCorrect =
        question && answer.selected_option_id === Number(question.correct_option_id)
          ? 1
          : 0;
      if (isCorrect) score++;
      return {
        question_id: answer.question_id,
        selected_option_id: answer.selected_option_id ?? null,
        is_correct: isCorrect,
      };
    });

    const total = key.length;
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
    const passingScore = Number(assessment.passing_score);
    const isPassed = percentage >= passingScore ? 1 : 0;

    const attemptId = await this.repository.recordAttempt(scope, {
      userId,
      assessmentId,
      score,
      totalQuestions: total,
      percentage,
      isPassed,
      answers: scored,
    });

    // Passing can complete the course. Best-effort — never breaks the attempt.
    if (isPassed === 1) {
      await this.certificates.autoIssue(scope, userId, courseId);
    }

    return {
      result: {
        attempt_id: attemptId,
        score,
        total_questions: total,
        percentage,
        is_passed: isPassed === 1,
        passing_score: passingScore,
        questions_review: key.map((question) => {
          const answer = scored.find(
            (a) => a.question_id === Number(question.id),
          );
          return {
            question_id: question.id,
            question_text: question.question_text,
            correct_option_id: question.correct_option_id,
            selected_option_id: answer?.selected_option_id ?? null,
            is_correct: answer?.is_correct === 1,
          };
        }),
      },
    };
  }

  /* ── Helpers ── */

  private attachOptions(
    questions: { id: number }[],
    options: (Record<string, unknown> & { question_id: number })[],
  ) {
    const byQuestion = new Map<number, unknown[]>();
    for (const option of options) {
      const key = Number(option.question_id);
      const list = byQuestion.get(key);
      if (list) list.push(option);
      else byQuestion.set(key, [option]);
    }

    return questions.map((question) => ({
      ...question,
      options: byQuestion.get(Number(question.id)) ?? [],
    }));
  }

  private assertHasCorrectOption(dto: QuestionDto): void {
    if (!dto.options.some((option) => option.is_correct)) {
      throw new BadRequestException('At least one correct option required');
    }
  }

  private async assertAssigned(
    scope: OrgScope,
    userId: number,
    courseId: number,
  ): Promise<void> {
    if (!(await this.repository.isAssignedToCourse(scope, userId, courseId))) {
      throw new ForbiddenException('Access denied');
    }
  }
}
