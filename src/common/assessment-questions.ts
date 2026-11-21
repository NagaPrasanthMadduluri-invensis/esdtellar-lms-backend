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

/* ── Grading the answer-backed types ── */

/**
 * Fill-in-the-blank matching rule: case- and whitespace-insensitive. Leading
 * and trailing space is dropped and any run of internal whitespace counts as
 * one space, so "  new   York " matches "New York".
 */
export function normaliseAnswer(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface MatchingPair {
  left: string;
  right: string;
}

/**
 * The stored matching key, as the admin editor writes it: one pair per line
 * as `left = right`. A `;` also separates pairs, and a JSON array of
 * `{left, right}` (the shape the schema comment names) is accepted too, so a
 * key written either way grades the same. Blank and malformed entries are
 * skipped.
 */
export function parseMatchingPairs(stored: string | null | undefined): MatchingPair[] {
  if (!stored || !stored.trim()) return [];
  const text = stored.trim();

  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (p): p is MatchingPair =>
              !!p &&
              typeof (p as MatchingPair).left === 'string' &&
              typeof (p as MatchingPair).right === 'string',
          )
          .map((p) => ({ left: p.left.trim(), right: p.right.trim() }))
          .filter((p) => p.left && p.right);
      }
    } catch {
      // Not JSON after all: fall through to the line format.
    }
  }

  return text
    .split(/[\n;]/)
    .map((entry) => {
      const at = entry.indexOf('=');
      if (at < 0) return null;
      return { left: entry.slice(0, at).trim(), right: entry.slice(at + 1).trim() };
    })
    .filter((p): p is MatchingPair => !!p && !!p.left && !!p.right);
}

/** What the grader needs to know about one question. */
export interface GradableQuestion {
  question_type: string;
  correct_answer: string | null;
  correct_option_ids: number[];
}

/** One learner answer, already stripped of foreign option ids. */
export interface GivenAnswer {
  selected_option_ids: number[];
  answer?: string | null;
  pairs?: MatchingPair[] | null;
}

/**
 * Is this answer right?
 *
 *   mcq / truefalse   the one chosen option is the correct one.
 *   multiselect       exactly the set of correct options: every correct one
 *                     chosen and no wrong one. One of two correct is wrong.
 *   fillblank         the typed text equals `correct_answer` (normalised).
 *   matching          every stored pair is matched, nothing extra.
 */
export function isAnswerCorrect(question: GradableQuestion, given: GivenAnswer): boolean {
  const type = question.question_type || 'mcq';

  if (type === 'fillblank') {
    const expected = normaliseAnswer(question.correct_answer);
    return expected.length > 0 && normaliseAnswer(given.answer) === expected;
  }

  if (type === 'matching') {
    const key = parseMatchingPairs(question.correct_answer);
    const pairs = given.pairs ?? [];
    if (key.length === 0 || pairs.length !== key.length) return false;
    const chosen = new Map<string, string>();
    for (const pair of pairs) {
      const left = normaliseAnswer(pair.left);
      if (chosen.has(left)) return false;
      chosen.set(left, normaliseAnswer(pair.right));
    }
    return key.every(
      (pair) => chosen.get(normaliseAnswer(pair.left)) === normaliseAnswer(pair.right),
    );
  }

  const correct = new Set(question.correct_option_ids.map(Number));
  const selected = new Set(given.selected_option_ids.map(Number));
  if (correct.size === 0 || selected.size !== correct.size) return false;
  return [...selected].every((id) => correct.has(id));
}
