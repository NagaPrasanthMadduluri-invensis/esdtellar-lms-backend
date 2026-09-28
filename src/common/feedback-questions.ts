/**
 * Question types a feedback template may use — the fourteenth
 * catalogue-as-code.
 *
 * Same argument every time: a value means something only because something
 * reads it. Three things do — the DTO that validates a template's questions,
 * the learner's form deciding what control to render, and the admin's editor
 * listing what may be added — so the list lives here and the browser mirrors
 * it in `client/lib/feedback-questions.js`.
 *
 * `optionBacked` is the one piece of behaviour: `choice` is the only type
 * that carries its own answers, and it is the only one for which an empty
 * `options` array is a broken question rather than a normal one. The
 * assessment editor switches on the same flag for the same reason
 * (§10.3.1.4) rather than on a chain of `if (type === ...)`.
 */

export interface FeedbackQuestionTypeDef {
  label: string;
  /** One line under the type in the admin's picker. */
  help: string;
  /** Does it need an `options` list? Only `choice` does. */
  optionBacked: boolean;
  /** A lucide component NAME (§10.3.1.6) — the browser maps it. */
  icon: string;
}

export const FEEDBACK_QUESTION_TYPES = {
  rating: {
    label: 'Rating (1–5)',
    help: 'Five stars. The only type that averages, so prefer it for anything you will want to compare.',
    optionBacked: false,
    icon: 'Star',
  },
  likert: {
    label: 'Agree scale',
    help: 'Strongly disagree → Strongly agree. Use for a statement, not a question.',
    optionBacked: false,
    icon: 'AlignLeft',
  },
  choice: {
    label: 'Multiple choice',
    help: 'One answer from a list you write.',
    optionBacked: true,
    icon: 'CircleDot',
  },
  yesno: {
    label: 'Yes / No',
    help: 'A single closed question.',
    optionBacked: false,
    icon: 'ToggleLeft',
  },
  text: {
    label: 'Open text',
    help: 'A free answer. Never required — a mandatory essay is how a form gets abandoned.',
    optionBacked: false,
    icon: 'Type',
  },
} as const satisfies Record<string, FeedbackQuestionTypeDef>;

export type FeedbackQuestionType = keyof typeof FEEDBACK_QUESTION_TYPES;

export const FEEDBACK_QUESTION_TYPE_IDS = Object.keys(
  FEEDBACK_QUESTION_TYPES,
) as FeedbackQuestionType[];

export function isFeedbackQuestionType(v: string): v is FeedbackQuestionType {
  return Object.prototype.hasOwnProperty.call(FEEDBACK_QUESTION_TYPES, v);
}

/** The five rungs of the agree scale, stored as the answer verbatim. */
export const LIKERT_SCALE = [
  'Strongly disagree',
  'Disagree',
  'Neutral',
  'Agree',
  'Strongly agree',
] as const;

/** The three seeded templates. Their KEYS are what the category resolver
 *  depends on, which is why a system template cannot be deleted. */
export const SYSTEM_TEMPLATE_KEYS = [
  'standard',
  'technical',
  'compliance',
] as const;
export type SystemTemplateKey = (typeof SYSTEM_TEMPLATE_KEYS)[number];

/**
 * Which template a course CATEGORY attaches by default.
 *
 * Only the two the owner named have their own; everything else falls to
 * `standard`. Stated as a map rather than an if-chain so adding a fourth is
 * one line here and nowhere else — and so the admin screen can print the
 * mapping without re-deriving it.
 */
export const CATEGORY_TEMPLATE: Record<string, SystemTemplateKey> = {
  Technical: 'technical',
  Compliance: 'compliance',
};

export const DEFAULT_TEMPLATE_KEY: SystemTemplateKey = 'standard';

/** The template key a course's category implies. Never null. */
export function templateKeyForCategory(
  category: string | null | undefined,
): SystemTemplateKey {
  if (!category) return DEFAULT_TEMPLATE_KEY;
  return CATEGORY_TEMPLATE[category] ?? DEFAULT_TEMPLATE_KEY;
}

/** Ratings are 1–5, like every other rating in the product (§10.20). */
export const FEEDBACK_RATING_MIN = 1;
export const FEEDBACK_RATING_MAX = 5;

/** How many questions one template may carry. A form nobody finishes
 *  collects nothing, and the limit is what stops one being built. */
export const MAX_TEMPLATE_QUESTIONS = 15;
