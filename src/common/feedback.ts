/**
 * Session feedback — the thirteenth catalogue-as-code, after `permissions`,
 * `badges`, `course-taxonomy`, `lesson-content`, `assessment-questions`,
 * `edstellar-services`, `session-enrolment`, `tenant-account`, `billing`,
 * `activity`, `notifications` and `industries`.
 *
 * Same argument every time: a value means something only because something
 * reads it. Three things read these — the learner's form, the trainer's
 * summary, and the DTO that validates a submission — so the list lives here
 * and the browser mirrors it in `client/lib/feedback.js`.
 *
 * WHY THREE DIMENSIONS AND NOT ONE AVERAGE
 *
 * They fail separately and they have different owners. Thin material is the
 * admin's to fix, an unclear explanation is the trainer's, a broken joining
 * link is neither. A single number would tell a trainer they scored 3.1 and
 * nothing about which of the three to change — and two of them are not even
 * theirs to change, which is worth saying on the page rather than leaving a
 * trainer to feel responsible for the venue.
 */

export const RATING_MIN = 1;
export const RATING_MAX = 5;

export interface FeedbackDimensionDef {
  /** The column on `session_feedback`. */
  column: 'rating_content' | 'rating_trainer' | 'rating_delivery';
  /** What the learner is asked. */
  label: string;
  /** One line under the stars, so "delivery" is not left to interpretation. */
  help: string;
  /**
   * Who can act on a poor score here. Rendered on the trainer's page so a
   * low Content score does not read as a personal failing — it is the one
   * dimension a trainer cannot fix by teaching differently.
   */
  ownedBy: 'trainer' | 'admin' | 'shared';
}

export const FEEDBACK_DIMENSIONS = {
  content: {
    column: 'rating_content',
    label: 'Course content',
    help: 'Was the material relevant, accurate and pitched at the right level?',
    ownedBy: 'admin',
  },
  trainer: {
    column: 'rating_trainer',
    label: 'Trainer',
    help: 'Was the trainer clear, well prepared and open to questions?',
    ownedBy: 'trainer',
  },
  delivery: {
    column: 'rating_delivery',
    label: 'Delivery & venue',
    help: 'Pacing, timings, and whether the room or joining link worked.',
    ownedBy: 'shared',
  },
} as const satisfies Record<string, FeedbackDimensionDef>;

export type FeedbackDimension = keyof typeof FEEDBACK_DIMENSIONS;

export const FEEDBACK_DIMENSION_IDS = Object.keys(
  FEEDBACK_DIMENSIONS,
) as FeedbackDimension[];

/**
 * The attendance statuses that entitle somebody to rate a session.
 *
 * Deliberately the SAME three that credit a learner for the training
 * (§10.7) rather than a second list. If completion ever stops meaning these
 * three, feedback eligibility should move with it — one definition of "was
 * in the room", not two that drift.
 */
export const FEEDBACK_ELIGIBLE_ATTENDANCE = [
  'present',
  'late',
  'partial',
] as const;

/**
 * How many responses before a per-session average is worth printing.
 *
 * Under this the trainer page shows the count and withholds the number. One
 * response is not an average, and a single 2/5 rendered as "2.0 average"
 * invites a conclusion three more responses might reverse — the same reason
 * the analytics trends refuse to draw a line through two points
 * (`sufficient: false`, §10.12).
 */
export const MIN_RESPONSES_FOR_AVERAGE = 3;
