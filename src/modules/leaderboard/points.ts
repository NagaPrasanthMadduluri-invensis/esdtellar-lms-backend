/**
 * The points model, defined once so the learner board, the admin board, the
 * course cards and the points history cannot drift apart.
 *
 * It follows the reference design's rule set (`spectra-lms - updated with
 * feedback`), minus the four community rules — there is no community feature
 * here, and a rule nothing can trigger is the screen-that-lies failure
 * §5.2.1 exists to prevent. Every rule below is paid by
 * `LeaderboardRepository.pointEvents()`, which is the ONLY place an event is
 * turned into points.
 *
 * Lessons no longer pay on their own. The reference pays for FINISHING a
 * course, not for each step inside one, and paying both would let a course
 * with many short lessons outscore a harder one with few.
 */
export const POINTS_COURSE_COMPLETED = 100;
export const POINTS_FINISHED_EARLY = 75;
export const POINTS_ASSESSMENT_PASSED = 50;
export const POINTS_TOP_SCORE = 150;
export const POINTS_PERFECT_SCORE = 200;
export const POINTS_FEEDBACK_SUBMITTED = 15;
export const POINTS_SESSION_ATTENDED = 40;

/** A passed score at or above this is a top score; 100 is a perfect one. */
export const TOP_SCORE_THRESHOLD = 90;
export const PERFECT_SCORE = 100;

/**
 * What ONE assessment pays, from the learner's best PASSING score on it.
 *
 * The three score rules are tiers, not a stack: an assessment pays exactly one
 * of them, decided by the best score, so passing at 72% and later re-sitting
 * at 95% upgrades 50 to 150 rather than paying 200. "Passed" means the
 * assessment's OWN pass mark — the same `is_passed` every other screen reads —
 * not a fixed 60%, so a quiz set at 70% cannot pay a 65.
 *
 * The SQL in `LeaderboardRepository` mirrors this with the same constants.
 */
export function assessmentTierPoints(bestPassedScore: number): number {
  if (bestPassedScore >= PERFECT_SCORE) return POINTS_PERFECT_SCORE;
  if (bestPassedScore >= TOP_SCORE_THRESHOLD) return POINTS_TOP_SCORE;
  return POINTS_ASSESSMENT_PASSED;
}

/**
 * What a single course is worth, and how much of it the learner already holds.
 *
 * The learner is told this BEFORE they finish — "earn 150 points" on a card
 * they have not opened — so it has to be the same rules the leaderboard pays
 * out afterwards, or the card is a promise the board does not keep.
 *
 * `totalPoints` is the GUARANTEED figure: completion, the early bonus while it
 * can still be won, and the pass rate for each assessment. A top or perfect
 * score pays more than that, which is why `maxPoints` exists and why
 * `totalPoints` is raised to `earnedPoints` once a high score has been banked
 * — "230 of 150 earned" would read as a bug.
 */
export interface CourseReward {
  /** Course completion, or attendance for a session's training. */
  completionPoints: number;
  /** The early bonus, when it is earned or still winnable; else 0. */
  earlyPoints: number;
  assessmentCount: number;
  perAssessmentMin: number;
  perAssessmentMax: number;
  totalPoints: number;
  maxPoints: number;
  earnedPoints: number;
  remainingPoints: number;
}

export function courseReward(input: {
  /** A session's companion training pays attendance, never completion. */
  isSession: boolean;
  /** An approved external certification pays nothing — see POINTS_NOTES. */
  isExternal: boolean;
  complete: boolean;
  assessmentCount: number;
  /** Best passing score per passed assessment of this course. */
  bestPassedScores: number[];
  earnedEarly: boolean;
  earlyWinnable: boolean;
}): CourseReward {
  if (input.isExternal) {
    return {
      completionPoints: 0, earlyPoints: 0, assessmentCount: 0,
      perAssessmentMin: POINTS_ASSESSMENT_PASSED, perAssessmentMax: POINTS_PERFECT_SCORE,
      totalPoints: 0, maxPoints: 0, earnedPoints: 0, remainingPoints: 0,
    };
  }

  const completionPoints = input.isSession ? POINTS_SESSION_ATTENDED : POINTS_COURSE_COMPLETED;
  const earlyPoints =
    !input.isSession && (input.earnedEarly || input.earlyWinnable) ? POINTS_FINISHED_EARLY : 0;
  const assessmentCount = input.isSession ? 0 : input.assessmentCount;

  const base = completionPoints + earlyPoints;
  const earnedPoints =
    (input.complete ? completionPoints : 0) +
    (input.earnedEarly && !input.isSession ? POINTS_FINISHED_EARLY : 0) +
    input.bestPassedScores.reduce((sum, score) => sum + assessmentTierPoints(score), 0);

  const totalPoints = Math.max(base + assessmentCount * POINTS_ASSESSMENT_PASSED, earnedPoints);
  const maxPoints = Math.max(base + assessmentCount * POINTS_PERFECT_SCORE, earnedPoints);

  return {
    completionPoints,
    earlyPoints,
    assessmentCount,
    perAssessmentMin: POINTS_ASSESSMENT_PASSED,
    perAssessmentMax: POINTS_PERFECT_SCORE,
    totalPoints,
    maxPoints,
    earnedPoints,
    remainingPoints: Math.max(totalPoints - earnedPoints, 0),
  };
}

/**
 * HOW POINTS ARE EARNED, as a list a learner can read — the "How Points
 * Work" tab.
 *
 * Catalogue-as-code, built from the SAME constants the board pays out with,
 * never re-typed numbers. A hardcoded table beside a live formula is the
 * screen-that-lies failure, and it is worse here than usual: a learner reading
 * "perfect score +200" and never receiving it stops trusting the board.
 *
 * Order and wording follow the reference. `key` is also the rule name a
 * points-history row carries, so the history can label itself from here.
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
    key: 'course_completed',
    activity: 'Course completed',
    earnedBy: 'Finish every lesson of a course assigned to you or one you added yourself.',
    points: POINTS_COURSE_COMPLETED,
  },
  {
    key: 'assessment_passed',
    activity: 'Assessment passed',
    earnedBy: `Pass an assessment with a best score below ${TOP_SCORE_THRESHOLD}%.`,
    points: POINTS_ASSESSMENT_PASSED,
    note: 'Passing means reaching the pass mark the assessment sets.',
  },
  {
    key: 'top_score',
    activity: `Top score (${TOP_SCORE_THRESHOLD}%+)`,
    earnedBy: `Pass an assessment with a best score of ${TOP_SCORE_THRESHOLD}% or more, short of ${PERFECT_SCORE}%.`,
    points: POINTS_TOP_SCORE,
  },
  {
    key: 'perfect_score',
    activity: `Perfect score (${PERFECT_SCORE}%)`,
    earnedBy: `Score a perfect ${PERFECT_SCORE}% on an assessment.`,
    points: POINTS_PERFECT_SCORE,
    note: 'An assessment pays ONE of the three score rules, decided by your best score. Re-sitting to a higher band upgrades it; re-sitting in the same band pays nothing more.',
  },
  {
    key: 'feedback_submitted',
    activity: 'Feedback submitted',
    earnedBy: 'Submit feedback on a course you finished or a session you attended.',
    points: POINTS_FEEDBACK_SUBMITTED,
    note: 'Once per course or session. Editing your answer later pays nothing more.',
  },
  {
    key: 'finished_early',
    activity: 'Finished early',
    earnedBy: 'Complete a course before its due date.',
    points: POINTS_FINISHED_EARLY,
    note: 'Paid on top of Course completed.',
  },
  {
    key: 'session_attended',
    activity: 'Session attended',
    earnedBy: 'Be marked present at a live session once your trainer completes it.',
    points: POINTS_SESSION_ATTENDED,
    note: 'Late and partial attendance count, as they do for the training itself.',
  },
  {
    key: 'journey_completed',
    activity: 'Learning path completed',
    earnedBy: 'Finish every required step of a learning path.',
    points: null,
    pointsLabel: 'set per path',
    note: 'Each path carries its own bonus, because a three-course path and a twelve-course path are not worth the same.',
  },
];

/** What the board does NOT pay for, stated because learners ask. */
export const POINTS_NOTES: readonly string[] = [
  'Points are all-time. The monthly board is the same rules counted over this month only.',
  'An approved external certification adds to your courses and hours, but not to your points — it was earned outside this platform.',
  'Only active learners appear on the board.',
];
