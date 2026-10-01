import type { EmailPolicy } from '@/common/notifications';

/**
 * DIRECT emails — the ones with no bell counterpart.
 *
 * `common/notifications.ts` is the catalogue for everything a learner can see
 * in the bell, and 25 of the 26 messages this product sends come from there.
 * These do not, and the reason is not symmetry for its own sake:
 *
 *   - **password_reset** goes to somebody who is NOT SIGNED IN. There is no
 *     bell for them to look at, and writing a notification row would record
 *     "this person asked to reset their password" where their colleagues'
 *     admin can read it. The absence of a bell row is a privacy property.
 *   - **password_changed** could be a notification, and deliberately is not:
 *     its whole job is to reach somebody whose account may have just been
 *     taken over. A bell row inside the account an attacker now controls is
 *     worth nothing.
 *   - **welcome** carries a credential. It is sent once, at creation, before
 *     the person has ever signed in.
 *
 * All three are `transactional` and none is opt-outable below the master
 * switch. A password reset somebody cannot receive is an account they cannot
 * recover.
 */
export interface DirectEmailDef {
  /** Fallback subject. The service composes the real one. */
  label: string;
  /** Picks the colour and the eyebrow on the rendered email. */
  group: string;
  policy: EmailPolicy;
}

export const DIRECT_EMAIL_TYPES = {
  password_reset: {
    label: 'Reset your password',
    group: 'security',
    policy: 'transactional',
  },
  password_changed: {
    label: 'Your password was changed',
    group: 'security',
    policy: 'transactional',
  },
  welcome: {
    label: 'Your account is ready',
    group: 'people',
    policy: 'transactional',
  },
} as const satisfies Record<string, DirectEmailDef>;

export type DirectEmailType = keyof typeof DIRECT_EMAIL_TYPES;

export const DIRECT_EMAIL_IDS = Object.keys(
  DIRECT_EMAIL_TYPES,
) as DirectEmailType[];

export function isDirectEmailType(type: string): type is DirectEmailType {
  return Object.prototype.hasOwnProperty.call(DIRECT_EMAIL_TYPES, type);
}

/**
 * Types that ignore `all_off`.
 *
 * The master switch is honoured for everything else, transactional included
 * — §10.18's guarantee that nothing in the notification system is the only
 * way somebody learns something is what makes that affordable.
 *
 * These three break the guarantee, which is exactly why they are listed. A
 * password reset is not available anywhere else: there is no screen to check,
 * because the person cannot sign in. Suppressing it would turn a preference
 * into a lockout.
 */
export const UNSUPPRESSABLE: ReadonlySet<string> = new Set<string>([
  'password_reset',
  'password_changed',
]);
