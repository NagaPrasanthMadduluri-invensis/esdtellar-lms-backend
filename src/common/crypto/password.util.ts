import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * The ASYNC scrypt, off the main thread.
 *
 * `scryptSync` blocks the single Node thread for ~38 ms per call — fine for
 * one login, ruinous in the bulk-import loop, where 300 rows meant ~11
 * seconds in which the single API process could serve NO other request
 * (BACKEND_STRUCTURE §10.30 risk 7). `scrypt` runs the same computation on
 * libuv's thread pool and yields the event loop between calls, so other
 * requests are served while an import hashes.
 *
 * ## Why this matters MORE in a multi-tenant system
 *
 * The API is one shared process (`instances: 1`) serving every tenant. A
 * synchronous hash loop does not just slow the admin running the import —
 * it freezes the thread that serves EVERY OTHER ORGANIZATION. One tenant
 * bulk-importing 300 learners made every other tenant's learner wait on
 * their own dashboard for the duration. Offloading the hash to the thread
 * pool is what keeps one tenant's onboarding from becoming another
 * tenant's outage, which is a stronger reason than this one admin's
 * latency and the real reason not to revert this to `scryptSync`.
 *
 * It is byte-for-byte identical to `scryptSync` with the same arguments —
 * same default cost parameters (N=16384, r=8, p=1) — which is what lets this
 * change the WRITE path without touching the format §6.4 locks. Verified:
 * the two produce the same 64-byte key for the same (password, salt).
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

/**
 * Storage format: `<derivedKeyHex>.<saltHex>` (161 chars).
 *
 * These parameters are NOT free to change: every existing row in `users.password`
 * was produced by `scrypt(password, salt, 64)` with a 16-byte hex salt. Any
 * change here locks out every existing account. Rotating to a stronger KDF means
 * re-hashing on next successful login, not editing these constants.
 *
 * ASYNC since 2026-10-07 — see `scryptAsync` for why. The format is unchanged,
 * so this is a performance fix, not a credential change; the only visible
 * effect is that callers `await` it, which every caller already could because
 * they were all async.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return `${derived.toString('hex')}.${salt}`;
}

/**
 * Deliberately SYNC, unlike `hashPassword`.
 *
 * It is called once per login or password change — never in a loop — so the
 * 38 ms block is one request's own latency, not a batch that starves the
 * process. Making it async would ripple `await` through the auth hot path
 * for no benefit. `scryptSync` is correct here; the asymmetry is intended.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [hash, salt] = stored.split('.');
    if (!hash || !salt) return false;

    const storedBuf = Buffer.from(hash, 'hex');
    const suppliedBuf = scryptSync(password, salt, KEY_LENGTH);

    // timingSafeEqual throws on length mismatch — guard before comparing.
    if (storedBuf.length !== suppliedBuf.length) return false;
    return timingSafeEqual(storedBuf, suppliedBuf);
  } catch {
    return false;
  }
}

/** Mirrors the policy the register/change-password UI enforces client-side. */
export function isPasswordStrong(password: string): boolean {
  return (
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}
