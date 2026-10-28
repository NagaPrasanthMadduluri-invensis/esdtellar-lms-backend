import {
  COMMUNITY_HASHTAG_MAX,
  COMMUNITY_HASHTAGS_PER_POST_MAX,
} from './content-limits';

/**
 * Hashtag normalisation, shared so the server (what it stores and requires) and
 * the browser (what it previews while typing) agree to the character.
 * `client/lib/community-hashtags.js` mirrors this — change both.
 *
 * NORMALISING is the whole feature: `#Renewables`, `renewables` and ` Renewables `
 * all collapse to the one stored tag `renewables`, so a tenant never gets two
 * tags that differ only in case or a stray #. The `label` keeps the casing the
 * tag was FIRST seen in, for the chip; the `tag` is what everything matches on.
 */

/** A single raw token → its normalised tag + display label, or null if empty. */
export function normalizeHashtag(
  raw: unknown,
): { tag: string; label: string } | null {
  if (typeof raw !== 'string') return null;
  // Drop a leading #, trim, then keep only letters, digits and underscore.
  const cleaned = raw
    .trim()
    .replace(/^#+/, '')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .slice(0, COMMUNITY_HASHTAG_MAX);
  if (!cleaned) return null;
  return { tag: cleaned.toLowerCase(), label: cleaned };
}

/** Pull inline #tokens out of a blob of text (title or body). */
export function extractInlineHashtags(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  const matches = text.match(/#[\p{L}\p{N}_]+/gu);
  return matches ?? [];
}

/**
 * Normalise a mixed list of raw tokens (explicit chips plus anything pulled
 * inline), de-duplicate by the normalised tag, and cap the count. First casing
 * wins for the label. Returns at most `COMMUNITY_HASHTAGS_PER_POST_MAX`.
 */
export function collectHashtags(
  raws: unknown[],
): { tag: string; label: string }[] {
  const seen = new Map<string, string>(); // tag -> label (first wins)
  for (const raw of raws ?? []) {
    const n = normalizeHashtag(raw);
    if (!n) continue;
    if (!seen.has(n.tag)) seen.set(n.tag, n.label);
    if (seen.size >= COMMUNITY_HASHTAGS_PER_POST_MAX) break;
  }
  return [...seen].map(([tag, label]) => ({ tag, label }));
}
