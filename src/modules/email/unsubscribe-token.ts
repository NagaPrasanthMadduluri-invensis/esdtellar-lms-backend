import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless unsubscribe tokens, signed with `JWT_SECRET`.
 *
 * ## Why there is no table
 *
 * A stored token needs a row per email sent, a cleanup job, and a decision
 * about what happens when the row is gone. An HMAC needs none of those: the
 * token IS the proof, verified by recomputing it.
 *
 * ## Why there is no expiry
 *
 * Deliberate, and the opposite of what a security reflex suggests. An
 * unsubscribe link in a two-year-old email that answers "this link has
 * expired" does not make the person re-subscribe — it makes them press the
 * spam button, which is the single most damaging thing that can happen to a
 * sending domain. The link must work forever.
 *
 * The exposure that buys is small and bounded: the worst a leaked token does
 * is stop email reaching its own owner. It cannot read anything, cannot sign
 * in, and cannot turn email back ON — `resubscribe` is not a token
 * operation, it is a signed-in one. Rotating `JWT_SECRET` invalidates every
 * token at once if that is ever needed.
 */

export type UnsubscribePurpose = 'all' | string;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createUnsubscribeToken(
  secret: string,
  userId: number,
  purpose: UnsubscribePurpose,
): string {
  const payload = `${userId}.${purpose}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(secret, payload)}`;
}

/**
 * Returns null for anything that does not verify — malformed, wrong
 * signature, or a payload that does not parse. The caller must treat null as
 * "show the generic page", never as "unsubscribe somebody anyway".
 */
export function readUnsubscribeToken(
  secret: string,
  token: string,
): { userId: number; purpose: UnsubscribePurpose } | null {
  if (!token || typeof token !== 'string') return null;

  const cut = token.lastIndexOf('.');
  if (cut <= 0) return null;

  const encoded = token.slice(0, cut);
  const provided = token.slice(cut + 1);

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = sign(secret, payload);

  // Length-check first: timingSafeEqual throws on a length mismatch, and a
  // throw here would be an exception-shaped oracle.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return null;
  }

  const dot = payload.indexOf('.');
  if (dot <= 0) return null;

  const userId = Number(payload.slice(0, dot));
  const purpose = payload.slice(dot + 1);
  if (!Number.isInteger(userId) || userId <= 0 || !purpose) return null;

  return { userId, purpose };
}
