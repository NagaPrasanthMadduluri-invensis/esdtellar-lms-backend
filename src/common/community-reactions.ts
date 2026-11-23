/**
 * Quick reactions on a Learning community Post (0073). The closed catalogue,
 * shared so the API (what it accepts) and the browser (what it offers) agree.
 * `client/lib/community-reactions.js` mirrors this: change both.
 *
 * A person holds ONE reaction per Post. Choosing another kind replaces it, so
 * a Post's total (`like_count`) never counts the same person twice.
 */
export const COMMUNITY_REACTIONS = [
  'like',
  'helpful',
  'insightful',
  'thanks',
  'great_explanation',
  'agree',
] as const;

export type CommunityReaction = (typeof COMMUNITY_REACTIONS)[number];

export const COMMUNITY_REACTION_LABELS: Record<CommunityReaction, string> = {
  like: 'Like',
  helpful: 'Helpful',
  insightful: 'Insightful',
  thanks: 'Thanks',
  great_explanation: 'Great explanation',
  agree: 'Agree',
};

export function isCommunityReaction(value: unknown): value is CommunityReaction {
  return (
    typeof value === 'string' &&
    (COMMUNITY_REACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Per-kind counts as stored ({kind: n}) to a full, ordered map with every kind
 * present (zero when unused), dropping anything outside the catalogue. The
 * client renders straight from it without guarding missing keys.
 */
export function normalizeReactionCounts(
  raw: unknown,
): Record<CommunityReaction, number> {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<CommunityReaction, number>;
  for (const kind of COMMUNITY_REACTIONS) {
    const n = Number(src[kind]);
    out[kind] = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }
  return out;
}
