/**
 * The badge catalogue — `specs/learning-journeys.md` §3.6, §4.5.
 *
 * THIS FILE IS THE CATALOGUE, on the same principle as `common/permissions.ts`:
 * the database stores who has earned which badge (`user_badges`); it does not
 * store what badges exist or what earns them. A badge key means something ONLY
 * because an award rule references it, so adding one is a reviewed code
 * change, not a row an admin can create.
 *
 * Before this file, the same nine badges were recomputed on every read of
 * `GET /learner/achievements` and each threshold was written down THREE
 * times — once in `BADGE_DEFS`, once in the `hasBadge()` switch, once again in
 * `badgeHint()` — so a threshold changed in one place silently disagreed with
 * the other two. Every badge here states its threshold ONCE, as data on the
 * entry (`metric` + `threshold`), and a later change wires `learner.service.ts`
 * onto it and persists the award into `user_badges` instead of deriving it on
 * read.
 *
 * `metric` names the single number a badge is measured against, compared with
 * `>=` — the same comparison every one of the nine badges already used. Two
 * badges (`assessment_topper`, `perfectionist`) are framed as a bar on the
 * learner's best assessment score rather than a count, which is why the value
 * is a percentage rather than a number of occurrences; the comparison is still
 * `>=`.
 */

export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'platinum' | null;

/**
 * The stat a badge's `threshold` is compared against, `>=`. `journeysCompleted`
 * backs the three journey milestones (§4.5); the rest back the nine existing
 * badges, unchanged from `learner.service.ts`'s `BadgeStats`.
 */
export type BadgeMetric =
  | 'completedCourses'
  | 'completedBeforeDue'
  | 'maxAssessmentScore'
  | 'feedbackCount'
  | 'points'
  | 'journeysCompleted';

export interface BadgeDefinition {
  label: string;
  description: string;
  tier: BadgeTier;
  /** A lucide icon name. */
  icon: string;
  metric: BadgeMetric;
  /** The single number this badge's `metric` must reach. Stated once, here. */
  threshold: number;
}

/**
 * The nine existing badges, moved VERBATIM (id, label, tier, icon, threshold)
 * from `BADGE_DEFS` / `hasBadge()` in `learner.service.ts`, plus the three
 * journey milestones (§4.5). Per-journey badges (`journey:<id>`) are the one
 * exception and are NOT catalogued here — their label and icon come from the
 * journey row itself, not a fixed entry, because there is one per journey an
 * admin creates rather than a fixed set an engineer reviews.
 */
export const BADGES = {
  first_steps: {
    label: 'First Steps',
    description: 'Completed your first course',
    tier: 'bronze',
    icon: 'target',
    metric: 'completedCourses',
    threshold: 1,
  },
  quick_learner: {
    label: 'Quick Learner',
    description: 'Completed a course before its due date',
    tier: null,
    icon: 'zap',
    metric: 'completedBeforeDue',
    threshold: 1,
  },
  assessment_topper: {
    label: 'Assessment Topper',
    description: 'Scored 90% or higher on an assessment',
    tier: 'gold',
    icon: 'trophy',
    metric: 'maxAssessmentScore',
    threshold: 90,
  },
  perfectionist: {
    label: 'Perfectionist',
    description: 'Achieved a perfect 100% on an assessment',
    tier: 'platinum',
    icon: 'perfect',
    metric: 'maxAssessmentScore',
    threshold: 100,
  },
  committed_learner: {
    label: 'Committed Learner',
    description: 'Completed 3 or more courses',
    tier: 'silver',
    icon: 'books',
    metric: 'completedCourses',
    threshold: 3,
  },
  scholar: {
    label: 'Scholar',
    description: 'Completed 5 or more courses',
    tier: 'gold',
    icon: 'scholar',
    metric: 'completedCourses',
    threshold: 5,
  },
  feedback_hero: {
    label: 'Feedback Hero',
    description: 'Submitted feedback on 3 or more courses',
    tier: null,
    icon: 'feedback',
    metric: 'feedbackCount',
    threshold: 3,
  },
  high_flyer: {
    label: 'High Flyer',
    description: 'Earned 500 or more points',
    tier: 'silver',
    icon: 'rocket',
    metric: 'points',
    threshold: 500,
  },
  learning_champion: {
    label: 'Learning Champion',
    description: 'Earned 1000 or more points',
    tier: 'gold',
    icon: 'crown',
    metric: 'points',
    threshold: 1000,
  },
  // Journey milestones (§4.5) — reached by finishing any journey at all, and
  // then by volume. Distinct from a per-journey badge: these are earned once
  // each, regardless of WHICH journeys were completed.
  journey_first: {
    label: 'Journey Starter',
    description: 'Completed your first learning journey',
    tier: 'bronze',
    icon: 'map',
    metric: 'journeysCompleted',
    threshold: 1,
  },
  journey_three: {
    label: 'Path Finder',
    description: 'Completed 3 or more learning journeys',
    tier: 'silver',
    icon: 'compass',
    metric: 'journeysCompleted',
    threshold: 3,
  },
  journey_five: {
    label: 'Trailblazer',
    description: 'Completed 5 or more learning journeys',
    tier: 'gold',
    icon: 'flag',
    metric: 'journeysCompleted',
    threshold: 5,
  },
} as const satisfies Record<string, BadgeDefinition>;

/** Every valid catalogued badge id (excludes per-journey `journey:<id>` keys). */
export type BadgeId = keyof typeof BADGES;

/** Ordered ids — the order an achievements page renders its rows in. */
export const BADGE_IDS = Object.keys(BADGES) as BadgeId[];

/** Shape a badges list endpoint hands back. */
export interface BadgeDescriptor extends BadgeDefinition {
  id: BadgeId;
}

export const BADGE_CATALOGUE: BadgeDescriptor[] = BADGE_IDS.map((id) => ({
  id,
  ...BADGES[id],
}));

/** Narrowing guard for anything arriving from a request body or the database. */
export function isBadge(value: unknown): value is BadgeId {
  return typeof value === 'string' && value in BADGES;
}

/**
 * The `badge_key` a per-journey badge is stored and awarded under. Not in
 * `BADGES` — there is one of these per journey an admin creates, taking its
 * label and icon from that journey's own `badge_label` / `badge_icon` rather
 * than a fixed catalogue entry.
 */
export function journeyBadgeKey(journeyId: number): string {
  return `journey:${journeyId}`;
}

/** Narrowing guard for a `user_badges.badge_key` shaped like `journey:<id>`. */
export function isJourneyBadgeKey(value: string): boolean {
  return /^journey:\d+$/.test(value);
}
