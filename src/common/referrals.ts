/**
 * The referral pipeline statuses — the validator source for the DTOs and the
 * vocabulary the platform queue advances through.
 *
 * A referral is born `invited` (the invitation email fires on submit) and only
 * Edstellar — a platform admin — moves it on. `converted` is the one that
 * matters: it is what the reward tier counts (see `referral-rewards.ts`) and
 * what the referrer sees as "Now a Spectra customer".
 *
 * `client/lib/referrals.js` mirrors this (labels + chip tones). Change both.
 */
export const REFERRAL_STATUSES = [
  'invited',
  'contacted',
  'qualified',
  'converted',
  'declined',
] as const;

export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_STATUS_DEFAULT: ReferralStatus = 'invited';

/** The one status the reward tier counts. */
export const REFERRAL_CONVERTED: ReferralStatus = 'converted';
