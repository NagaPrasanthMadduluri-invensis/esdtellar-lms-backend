import { referralTier, REFERRAL_TIERS } from './referral-rewards';

describe('referralTier', () => {
  it('earns nothing below the first tier', () => {
    expect(referralTier(0)).toMatchObject({ discountPct: 0, nextTierAt: 2, nextDiscountPct: 15, toNext: 2 });
    expect(referralTier(1)).toMatchObject({ discountPct: 0, nextTierAt: 2, toNext: 1 });
  });

  it('earns 15% at 2 conversions, 25% at 3', () => {
    expect(referralTier(2)).toMatchObject({ discountPct: 15, nextTierAt: 3, nextDiscountPct: 25, toNext: 1 });
    expect(referralTier(3)).toMatchObject({ discountPct: 25, nextTierAt: null, nextDiscountPct: null, toNext: 0 });
  });

  it('stays at the top tier beyond the last threshold', () => {
    expect(referralTier(9)).toMatchObject({ discountPct: 25, nextTierAt: null, toNext: 0 });
  });

  it('clamps and floors the count', () => {
    expect(referralTier(-5).convertedCount).toBe(0);
    expect(referralTier(2.9)).toMatchObject({ convertedCount: 2, discountPct: 15 });
  });

  it('tiers are ordered highest-first so the first match is the best', () => {
    expect(REFERRAL_TIERS[0].min).toBeGreaterThan(REFERRAL_TIERS[1].min);
  });
});
