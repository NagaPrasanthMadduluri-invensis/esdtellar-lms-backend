import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

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

  async listAll() {
    const rows = (await this.repository.listAll()) as Record<string, unknown>[];
    return {
      assessments: rows.map((row) => ({
        ...row,
        is_active: Number(row.is_active) === 1,
      })),
    };
  }

  async listByCourse(courseId: number) {
    return { assessments: await this.repository.listByCourse(courseId) };
  }

  async create(courseId: number, dto: AssessmentDto) {
    const assessment = await this.repository.createAssessment({
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
  async setAttached(assessmentId: number, attached: boolean) {
    const assessment = await this.repository.setAttached(assessmentId, attached);
    if (!assessment) throw new NotFoundException('Assessment not found');
    return { assessment, attached };
  }

  async update(assessmentId: number, dto: AssessmentDto) {
    const current = await this.repository.findById(assessmentId);
    if (!current) throw new NotFoundException('Assessment not found');

    const assessment = await this.repository.updateAssessment(assessmentId, {
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

  async remove(assessmentId: number) {
    await this.repository.deleteAssessment(assessmentId);
    return { message: 'Assessment deleted' };
  }

  /** Admin view — includes the answer key. */
  async getForAdmin(assessmentId: number) {
    const assessment = await this.repository.findById(assessmentId);
    if (!assessment) throw new NotFoundException('Assessment not found');

    const [questions, options] = await Promise.all([
      this.repository.listQuestions(assessmentId),
      this.repository.listOptionsForAssessment(assessmentId, true),
    ]);

    return {
      assessment,
      questions: this.attachOptions(questions, options),
    };
  }

  async addQuestion(assessmentId: number, dto: QuestionDto) {
    this.assertHasCorrectOption(dto);

    const sortOrder = await this.repository.nextQuestionSortOrder(assessmentId);
    const question = await this.repository.createQuestion({
      assessmentId,
      questionText: dto.question_text,
      marks: dto.marks || 1,
      sortOrder,
    });

    await this.repository.replaceOptions(question.id, dto.options);

    return {
      question: {
        ...question,
        options: await this.repository.listOptionsForQuestion(question.id),
      },
    };
  }

  async updateQuestion(questionId: number, dto: QuestionDto) {
    this.assertHasCorrectOption(dto);

    const question = await this.repository.updateQuestion(questionId, {
      questionText: dto.question_text,
      marks: dto.marks || 1,
    });
    if (!question) throw new NotFoundException('Question not found');

    await this.repository.replaceOptions(questionId, dto.options);

    return {
      question: {
        ...question,
        options: await this.repository.listOptionsForQuestion(questionId),
      },
    };
  }

  async removeQuestion(questionId: number) {
    await this.repository.deleteQuestion(questionId);
    return { message: 'Question deleted' };
  }

  /* ── Learner ── */

  async listForLearner(userId: number) {
    const [rows, attempts] = await Promise.all([
      this.repository.listForLearner(userId),
      this.repository.attemptsForLearner(userId),
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
  async getForLearner(assessmentId: number, userId: number) {
    const assessment = await this.repository.findActiveWithCourse(assessmentId);
    if (!assessment) throw new NotFoundException('Assessment not found');

    await this.assertAssigned(userId, Number(assessment.course_id));

    const [questions, options, attemptCount] = await Promise.all([
      this.repository.listQuestions(assessmentId),
      this.repository.listOptionsForAssessment(assessmentId, false),
      this.repository.countAttempts(userId, assessmentId),
    ]);

    return {
      assessment,
      questions: this.attachOptions(questions, options),
      attempt_count: attemptCount,
    };
  }

  async listAttempts(assessmentId: number, userId: number) {
    return { attempts: await this.repository.attemptsFor(userId, assessmentId) };
  }

  /** Grades server-side against the stored answer key. */
  async submitAttempt(
    assessmentId: number,
    userId: number,
    dto: SubmitAttemptDto,
  ) {
    const assessment = await this.repository.findActiveWithCourse(assessmentId);
    if (!assessment) throw new NotFoundException('Assessment not found');

    const courseId = Number(assessment.course_id);
    await this.assertAssigned(userId, courseId);

    const key = await this.repository.answerKey(assessmentId);

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

    const attemptId = await this.repository.recordAttempt({
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
      await this.certificates.autoIssue(userId, courseId);
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

  private async assertAssigned(userId: number, courseId: number): Promise<void> {
    if (!(await this.repository.isAssignedToCourse(userId, courseId))) {
      throw new ForbiddenException('Access denied');
    }
  }
}
