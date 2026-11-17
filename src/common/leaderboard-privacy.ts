/**
 * Leaderboard privacy (0064): how colleagues are named to each other on the
 * learner-facing leaderboard surfaces, and the organization's default.
 *
 * `initial` is "Priya S.", the same rule the community, course reviews and
 * the Home peer cards already follow. `full` is "Priya Sharma". Admin screens
 * never use this: an admin already sees the full record, so the admin
 * leaderboard keeps full names whatever the organization chose.
 *
 * `client/lib/leaderboard-privacy.js` mirrors the option list for the admin
 * settings form. Change both.
 */
export const LEADERBOARD_NAME_DISPLAYS = ['initial', 'full'] as const;
export type LeaderboardNameDisplay = (typeof LEADERBOARD_NAME_DISPLAYS)[number];
export const DEFAULT_LEADERBOARD_NAME_DISPLAY: LeaderboardNameDisplay = 'initial';

/** A stored value the code does not recognise falls back to the more private one. */
export function toNameDisplay(value: string | null | undefined): LeaderboardNameDisplay {
  return (LEADERBOARD_NAME_DISPLAYS as readonly string[]).includes(value ?? '')
    ? (value as LeaderboardNameDisplay)
    : DEFAULT_LEADERBOARD_NAME_DISPLAY;
}

/** The name a colleague sees on a leaderboard surface. */
export function leaderboardName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  display: LeaderboardNameDisplay,
): string {
  const first = (firstName ?? '').trim();
  const last = (lastName ?? '').trim();
  if (display === 'full') return `${first} ${last}`.trim();
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}
