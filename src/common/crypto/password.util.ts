import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/**
 * Storage format: `<derivedKeyHex>.<saltHex>` (161 chars).
 *
 * These parameters are NOT free to change: every existing row in `users.password`
 * was produced by `scryptSync(password, salt, 64)` with a 16-byte hex salt. Any
 * change here locks out every existing account. Rotating to a stronger KDF means
 * re-hashing on next successful login, not editing these constants.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = scryptSync(password, salt, KEY_LENGTH);
  return `${derived.toString('hex')}.${salt}`;
}

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
