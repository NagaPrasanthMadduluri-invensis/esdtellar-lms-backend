import type { BadgeDefinition } from '@/common/badges';

/**
 * The nudge text for a badge not yet earned, e.g. "Complete 2 more courses".
 *
 * Generic over `metric` rather than one switch case per badge id, because the
 * catalogue states each threshold ONCE (`common/badges.ts`) — a hint that
 * re-typed "3" or "500" here would be exactly the duplicated literal the
 * badges migration removed from `learner.service.ts`.
 */
export function badgeHint(def: BadgeDefinition, currentValue: number): string {
  const remaining = Math.max(def.threshold - currentValue, 0);
  const plural = remaining === 1 ? '' : 's';

  switch (def.metric) {
    case 'completedCourses':
      return `Complete ${remaining} more course${plural}`;
    case 'completedBeforeDue':
      return 'Finish a course before its due date';
    case 'maxAssessmentScore':
      return `Score ${def.threshold}% or higher on any assessment`;
    case 'feedbackCount':
      return `Submit feedback on ${remaining} more course${plural}`;
    case 'points':
      return `Earn ${remaining} more point${remaining === 1 ? '' : 's'}`;
    case 'journeysCompleted':
      return remaining <= 1
        ? 'Complete a learning journey'
        : `Complete ${remaining} learning journeys`;
    default:
      return '';
  }
}
