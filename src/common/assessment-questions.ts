/**
 * The question-type catalogue.
 *
 * Sixth catalogue-as-code here, and like `lesson-content.ts` each entry
 * carries a **validation rule**, which is what makes it code rather than data.
 *
 * TWO STORAGE SHAPES, and the split is the interesting part:
 *
 *   options-backed   `mcq`, `truefalse`, `multiselect` — the choices live in
 *                    `assessment_options`, one row each, carrying their own
 *                    order and an `is_correct` flag. A single text column
 *                    could not hold that.
 *   answer-backed    `fillblank`, `matching` — no fixed choices to render, so
 *                    the expected answer goes in `assessment_questions
 *                    .correct_answer`: plain text for fill-in-the-blank, JSON
 *                    pairs for matching.
 *
 * `truefalse` is options-backed on purpose rather than a boolean column: it is
 * a two-option multiple choice, and treating it as one means the attempt
 * grader, the option editor and the learner renderer all have a single path
 * instead of a special case each.
 */

export interface QuestionType {
  key: string;
  label: string;
  /** Does it store its choices as `assessment_options` rows? */
  optionBacked: boolean;
  /** Fixed number of options, when the type dictates one. */
  fixedOptions?: string[];
  /** May more than one option be correct? */
  multipleCorrect: boolean;
  hint: string;
}

export const QUESTION_TYPES: QuestionType[] = [
  {
    key: 'mcq',
    label: 'Multiple choice',
    optionBacked: true,
    multipleCorrect: false,
    hint: 'One correct answer from several options.',
  },
  {
    key: 'truefalse',
    label: 'True / False',
    optionBacked: true,
    fixedOptions: ['True', 'False'],
    multipleCorrect: false,
    hint: 'Two options, fixed. Mark which one is correct.',
  },
  {
    key: 'multiselect',
    label: 'Multiple select',
    optionBacked: true,
    multipleCorrect: true,
    hint: 'Several options, more than one correct. All must be chosen.',
  },
  {
    key: 'fillblank',
    label: 'Fill in the blank',
    optionBacked: false,
    multipleCorrect: false,
    hint: 'The learner types the answer. Matched case-insensitively.',
  },
  {
    key: 'matching',
    label: 'Matching',
    optionBacked: false,
    multipleCorrect: false,
    hint: 'Pairs of items the learner links together.',
  },
];

export const QUESTION_TYPE_KEYS = QUESTION_TYPES.map((t) => t.key);

export function questionType(key: string): QuestionType | undefined {
  return QUESTION_TYPES.find((t) => t.key === key);
}

/**
 * Unknown types answer true — the safe direction. An options-backed question
 * with no options is refused by validation and never silently ungradeable,
 * whereas an answer-backed one with a null answer would be.
 */
export function isOptionBacked(key: string): boolean {
  return questionType(key)?.optionBacked ?? true;
}

/** Where an assessment sits in a course. Mirrors `assessments.link_type`. */
export const ASSESSMENT_LINK_TYPES = ['course', 'module', 'lesson', 'none'] as const;

export type AssessmentLinkType = (typeof ASSESSMENT_LINK_TYPES)[number];

/** What the admin UI calls each placement. */
export const ASSESSMENT_LINK_LABELS: Record<AssessmentLinkType, string> = {
  course: 'Final assessment',
  module: 'Module',
  lesson: 'Lesson',
  none: 'Not placed',
};
