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
