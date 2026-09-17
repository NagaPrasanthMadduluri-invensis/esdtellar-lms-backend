/**
 * Tenant commercial vocabulary, and the contract-renewal rule.
 *
 * Ninth catalogue-as-code. `PLANS` and `BILLING_CYCLES` are validated by the
 * DTO, so a typo is a 422 naming the valid set rather than a value that
 * renders as an unknown chip forever.
 */

export const PLANS = ['starter', 'growth', 'enterprise'] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LABELS: Record<Plan, string> = {
  starter: 'Starter',
  growth: 'Growth',
  enterprise: 'Enterprise',
};

export const BILLING_CYCLES = ['monthly', 'quarterly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/**
 * How close to renewal counts as "soon".
 *
 * 60 days is the number the console warns at, and it is here rather than in a
 * query so the directory, the overview tile and any future email all agree
 * about what "expiring" means.
 */
export const RENEWAL_WARNING_DAYS = 60;

export type ContractState = 'none' | 'active' | 'expiring' | 'expired';

/**
 * A contract's state, DERIVED from its end date — never stored.
 *
 * Storing it would need something to run at midnight to move a contract from
 * `active` to `expired`, and there is no scheduler here. Worse, if that job
 * ever failed the stored value would contradict the date printed beside it.
 * Same reasoning as a session's `display_status` (§10.7).
 */
export function contractState(
  contractEnd: string | null | undefined,
  today = new Date(),
): { state: ContractState; daysLeft: number | null } {
  if (!contractEnd) return { state: 'none', daysLeft: null };

  const end = new Date(`${String(contractEnd).slice(0, 10)}T00:00:00Z`);
  const now = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  const daysLeft = Math.round((end.getTime() - now.getTime()) / 86_400_000);

  if (daysLeft < 0) return { state: 'expired', daysLeft };
  if (daysLeft <= RENEWAL_WARNING_DAYS) return { state: 'expiring', daysLeft };
  return { state: 'active', daysLeft };
}
