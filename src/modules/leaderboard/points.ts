/**
 * The points model, defined once so the learner board, the admin board and the
 * dashboard cannot drift apart.
 */
export const POINTS_PER_LESSON = 10;
export const POINTS_PER_PASSED_ASSESSMENT = 50;

/**
 * What a single course is worth, and how much of it the learner already holds.
 *
 * The learner is told this BEFORE they finish — "earn 120 points" on a card
 * they have not opened — so it has to be the same arithmetic the leaderboard
 * pays out afterwards, or the card is a promise the board does not keep. That
 * is the only reason it lives here beside the constants rather than in the
 * learner module: one file decides what a lesson and a pass are worth, and
 * both the promise and the payment read it.
 *
 * Points are NOT per-course in the model — the board sums a learner's lessons
 * and passes across everything. This is that same sum restricted to one
 * course's rows, which is exactly what completing the course would add.
 */
export interface CourseReward {
  perLesson: number;
  perAssessment: number;
  /** Lessons x POINTS_PER_LESSON. */
  lessonPoints: number;
  /** Active assessments x POINTS_PER_PASSED_ASSESSMENT. */
  assessmentPoints: number;
  /** Everything the course can pay. */
  totalPoints: number;
  /** Already credited: completed lessons + DISTINCT assessments passed. */
  earnedPoints: number;
  /** Still on the table. Never negative. */
  remainingPoints: number;
}

export function courseReward(input: {
  totalLessons: number;
  completedLessons: number;
  assessmentCount: number;
  passedAssessments: number;
}): CourseReward {
  const lessonPoints = input.totalLessons * POINTS_PER_LESSON;
  const assessmentPoints = input.assessmentCount * POINTS_PER_PASSED_ASSESSMENT;
  const totalPoints = lessonPoints + assessmentPoints;

  // Clamped to the total on purpose. Completions and passes can outlive the
  // rows they were earned against — a lesson or an assessment deactivated
  // after the fact still leaves its credit on the leaderboard but no longer
  // counts toward this course's ceiling. Reporting "130 of 120 earned" on a
  // card would read as a bug; the leaderboard total is unaffected either way.
  const earnedPoints = Math.min(
    input.completedLessons * POINTS_PER_LESSON +
      input.passedAssessments * POINTS_PER_PASSED_ASSESSMENT,
    totalPoints,
  );

  return {
    perLesson: POINTS_PER_LESSON,
    perAssessment: POINTS_PER_PASSED_ASSESSMENT,
    lessonPoints,
    assessmentPoints,
    totalPoints,
    earnedPoints,
    remainingPoints: Math.max(totalPoints - earnedPoints, 0),
  };
}

/**
 * HOW POINTS ARE EARNED, as a list a learner can read.
 *
 * Catalogue-as-code, and derived from the SAME constants the board pays out
 * with — the values below are the variables, never re-typed numbers, so a
 * change to `POINTS_PER_LESSON` moves the explanation and the payment
 * together. A hardcoded table beside a live formula is the screen-that-lies
 * failure §5.2.1 exists to prevent, and it is worse here than usual: a
 * learner reading "perfect score +200" and never receiving it stops trusting
 * the board entirely.
 *
 * THERE ARE THREE RULES, AND THAT IS THE WHOLE MODEL. The reference design
 * lists eleven — top score, perfect score, finished early, session attended,
 * community post, accepted answer. None of those is awarded by this product:
 * there is no community feature, no early-completion bonus, and a session is
 * paid through the lesson its attendance completes (§10.7) rather than as a
 * line of its own. They are absent rather than shown at zero.
 *
 * `points` is null where the value is not fixed — a learning path carries its
 * own `points_bonus`, so the row says so instead of naming a number that
 * would be wrong for every path but one.
 */
export interface PointRule {
  key: string;
  activity: string;
  earnedBy: string;
  points: number | null;
  /** Printed where a number cannot be. */
  pointsLabel?: string;
  note?: string;
}

export const POINT_RULES: readonly PointRule[] = [
  {
    key: 'lesson',
    activity: 'Lesson completed',
    earnedBy:
      'Finish any lesson in a course assigned to you or one you added yourself.',
    points: POINTS_PER_LESSON,
    note: 'Re-opening a lesson you have finished pays nothing more.',
  },
  {
    key: 'assessment',
    activity: 'Assessment passed',
    earnedBy: 'Score at or above the pass mark the assessment sets.',
    points: POINTS_PER_PASSED_ASSESSMENT,
    note: 'Counted once per assessment. Re-taking one you have already passed pays nothing.',
  },
  {
    key: 'journey',
    activity: 'Learning path completed',
    earnedBy: 'Finish every required step of a learning path.',
    points: null,
    pointsLabel: 'set per path',
    note: 'Each path carries its own bonus, because a three-course path and a twelve-course path are not worth the same.',
  },
];

/**
 * What the board does NOT pay for, stated because learners ask.
 *
 * Attending a live session feels like it should score, and it does — through
 * the lesson its attendance completes, not as a separate line. Saying so is
 * cheaper than fielding the question.
 */
export const POINTS_NOTES: readonly string[] = [
  'A live session pays through the lesson your attendance completes, at the lesson rate above.',
  'Points are all-time. The monthly board is the same rules counted over this month only.',
  'Only active learners appear on the board.',
];
