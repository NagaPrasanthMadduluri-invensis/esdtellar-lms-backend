/**
 * The referral reward tiers — a catalogue-as-code, like `permissions`,
 * `badges`, `points` and `edstellar-services`.
 *
 * 2 converted referrals earn 15% off the referrer's own Spectra subscription,
 * 3 earn 25%. The tier is DERIVED from the count of CONVERTED referrals at read
 * time (§10.36) — there is no stored discount column, because a number a
 * midnight job has to keep in step with the rows it summarises is a number that
 * drifts. The discount is SHOWN as earned; applying it to billing is a
 * deliberate platform-admin action, not an automation.
 *
 * `client/lib/referral-rewards.js` mirrors this for the progress UI. Change
 * both.
 */
export interface ReferralTier {
  /** Converted referrals needed to reach this tier. */
  min: number;
  /** The discount it earns, as a percentage. */
  discountPct: number;
}

/** Highest threshold first, so the first match is the best tier earned. */
export const REFERRAL_TIERS: readonly ReferralTier[] = [
  { min: 3, discountPct: 25 },
  { min: 2, discountPct: 15 },
] as const;

export interface EarnedTier {
  /** Converted referrals counted. */
  convertedCount: number;
  /** The discount earned so far, 0 until the first tier is reached. */
  discountPct: number;
  /** Converted referrals needed for the next tier, or null at the top. */
  nextTierAt: number | null;
  /** The discount the next tier would earn, or null at the top. */
  nextDiscountPct: number | null;
  /** How many more conversions to the next tier, or 0 at the top. */
  toNext: number;
}

/**
 * The tier a given count of converted referrals has earned, and the progress
 * toward the next one. One definition, read by the tenant list response and
 * mirrored to the browser so the showcase banner cannot disagree with it.
 */
export function referralTier(convertedCount: number): EarnedTier {
  const count = Math.max(0, Math.floor(convertedCount));
  const earned = REFERRAL_TIERS.find((t) => count >= t.min);
  const discountPct = earned?.discountPct ?? 0;

  // The lowest tier the count has NOT yet reached — the next one to aim for.
  const next = [...REFERRAL_TIERS]
    .sort((a, b) => a.min - b.min)
    .find((t) => count < t.min);

  return {
    convertedCount: count,
    discountPct,
    nextTierAt: next?.min ?? null,
    nextDiscountPct: next?.discountPct ?? null,
    toNext: next ? next.min - count : 0,
  };
}
