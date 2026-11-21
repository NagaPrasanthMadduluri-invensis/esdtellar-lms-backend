import { NotFoundException } from '@nestjs/common';

import { AssessmentsService } from './assessments.service';

const scope = { organizationId: 7, platformOrganizationId: 1 } as any;

function makeService(repoOverrides: Record<string, any> = {}) {
  const repo = {
    findById: jest.fn().mockResolvedValue({ id: 3 }),
    deleteAssessment: jest.fn().mockResolvedValue(undefined),
    findActiveWithCourse: jest
      .fn()
      .mockResolvedValue({ id: 3, course_id: 11, passing_score: 60 }),
    isAssignedToCourse: jest.fn().mockResolvedValue(true),
    answerKey: jest.fn().mockResolvedValue([]),
    recordAttempt: jest.fn().mockResolvedValue(99),
    listQuestions: jest.fn().mockResolvedValue([]),
    listOptionsForAssessment: jest.fn().mockResolvedValue([]),
    countAttempts: jest.fn().mockResolvedValue(0),
    ...repoOverrides,
  } as any;
  const gate = { assertUnlocked: jest.fn().mockResolvedValue(undefined) } as any;
  const noop = new Proxy({}, { get: () => jest.fn().mockResolvedValue(undefined) }) as any;
  const svc = new AssessmentsService(repo, noop, noop, gate, noop, noop);
  return { svc, repo };
}

describe('AssessmentsService.remove', () => {
  it('404s on a missing or foreign assessment and deletes nothing', async () => {
    const { svc, repo } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(svc.remove(scope, 3)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.deleteAssessment).not.toHaveBeenCalled();
  });

  it('deletes its own assessment', async () => {
    const { svc, repo } = makeService();
    await svc.remove(scope, 3);
    expect(repo.deleteAssessment).toHaveBeenCalledWith(scope, 3);
  });
});

describe('AssessmentsService.submitAttempt', () => {
  const key = [
    { id: 1, question_text: 'ms', question_type: 'multiselect', correct_answer: null, correct_option_id: 11, correct_option_ids: [10, 11], option_ids: [10, 11, 12] },
    { id: 2, question_text: 'fb', question_type: 'fillblank', correct_answer: 'Rome', correct_option_id: null, correct_option_ids: [], option_ids: [] },
    { id: 3, question_text: 'm', question_type: 'matching', correct_answer: 'A = 1\nB = 2', correct_option_id: null, correct_option_ids: [], option_ids: [] },
  ];

  it('scores every type and counts option-less questions in the total', async () => {
    const { svc, repo } = makeService({ answerKey: jest.fn().mockResolvedValue(key) });
    const { result } = await svc.submitAttempt(scope, 3, 5, {
      answers: [
        { question_id: 1, selected_option_ids: [11, 10] },
        { question_id: 2, answer: ' rome ' },
        { question_id: 3, pairs: [{ left: 'A', right: '1' }, { left: 'B', right: '2' }] },
      ],
    } as any);
    expect(result).toEqual(expect.objectContaining({ score: 3, total_questions: 3, percentage: 100, is_passed: true }));
    expect(repo.recordAttempt.mock.calls[0][1].answers).toEqual([
      { question_id: 1, selected_option_id: 11, is_correct: 1 },
      { question_id: 2, selected_option_id: null, is_correct: 1 },
      { question_id: 3, selected_option_id: null, is_correct: 1 },
    ]);
  });

  it('marks a multi-select with one of two correct options wrong, and drops foreign option ids', async () => {
    const { svc, repo } = makeService({ answerKey: jest.fn().mockResolvedValue(key) });
    const { result } = await svc.submitAttempt(scope, 3, 5, {
      answers: [{ question_id: 1, selected_option_id: 10, selected_option_ids: [999] }],
    } as any);
    expect(result.score).toBe(0);
    expect(repo.recordAttempt.mock.calls[0][1].answers[0]).toEqual({ question_id: 1, selected_option_id: 10, is_correct: 0 });
  });
});

describe('AssessmentsService.getForLearner', () => {
  it('never hands the learner the fill-in or matching key', async () => {
    const { svc } = makeService({
      listQuestions: jest.fn().mockResolvedValue([
        { id: 1, questionType: 'fillblank', questionText: 'x', correctAnswer: 'Rome' },
        { id: 2, questionType: 'matching', questionText: 'y', correctAnswer: 'B = 2\nA = 1' },
      ]),
    });
    const { questions } = await svc.getForLearner(scope, 3, 5);
    expect(JSON.stringify(questions)).not.toMatch(/Rome/);
    expect(questions[0].correct_answer).toBeNull();
    expect(questions[1]).toEqual(expect.objectContaining({ correct_answer: null, match_left: ['B', 'A'], match_right: ['1', '2'] }));
  });
});
