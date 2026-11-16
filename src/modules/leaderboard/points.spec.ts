import {
  assessmentTierPoints,
  courseReward,
  POINTS_ASSESSMENT_PASSED,
  POINTS_COURSE_COMPLETED,
  POINTS_FINISHED_EARLY,
  POINTS_PERFECT_SCORE,
  POINTS_SESSION_ATTENDED,
  POINTS_TOP_SCORE,
} from './points';

describe('assessmentTierPoints', () => {
  it('is a tier, not a stack — one band by best passing score', () => {
    expect(assessmentTierPoints(100)).toBe(POINTS_PERFECT_SCORE);
    expect(assessmentTierPoints(95)).toBe(POINTS_TOP_SCORE);
    expect(assessmentTierPoints(90)).toBe(POINTS_TOP_SCORE);
    expect(assessmentTierPoints(89)).toBe(POINTS_ASSESSMENT_PASSED);
    expect(assessmentTierPoints(60)).toBe(POINTS_ASSESSMENT_PASSED);
  });
});

describe('courseReward', () => {
  const base = {
    isSession: false,
    isExternal: false,
    complete: false,
    assessmentCount: 0,
    bestPassedScores: [] as number[],
    earnedEarly: false,
    earlyWinnable: false,
  };

  it('an external certification pays nothing', () => {
    const r = courseReward({ ...base, isExternal: true, complete: true });
    expect(r).toMatchObject({ totalPoints: 0, maxPoints: 0, earnedPoints: 0, completionPoints: 0 });
  });

  it('a completed plain course pays completion', () => {
    const r = courseReward({ ...base, complete: true });
    expect(r.completionPoints).toBe(POINTS_COURSE_COMPLETED);
    expect(r.earnedPoints).toBe(POINTS_COURSE_COMPLETED);
    expect(r.remainingPoints).toBe(0);
  });

  it('a session training pays attendance, not completion, and carries no assessments', () => {
    const r = courseReward({ ...base, isSession: true, complete: true, assessmentCount: 3 });
    expect(r.completionPoints).toBe(POINTS_SESSION_ATTENDED);
    expect(r.assessmentCount).toBe(0);
    expect(r.earnedPoints).toBe(POINTS_SESSION_ATTENDED);
  });

  it('counts the early bonus while it is still winnable, before it is earned', () => {
    const r = courseReward({ ...base, earlyWinnable: true });
    expect(r.earlyPoints).toBe(POINTS_FINISHED_EARLY);
    expect(r.totalPoints).toBe(POINTS_COURSE_COMPLETED + POINTS_FINISHED_EARLY);
    expect(r.earnedPoints).toBe(0);
  });

  it('raises totalPoints to earnedPoints once a high score is banked', () => {
    const r = courseReward({ ...base, complete: true, assessmentCount: 1, bestPassedScores: [100] });
    // 100 (completion) + 200 (perfect) = 300 earned; total must not read below earned.
    expect(r.earnedPoints).toBe(POINTS_COURSE_COMPLETED + POINTS_PERFECT_SCORE);
    expect(r.totalPoints).toBe(r.earnedPoints);
    expect(r.remainingPoints).toBe(0);
  });
});
