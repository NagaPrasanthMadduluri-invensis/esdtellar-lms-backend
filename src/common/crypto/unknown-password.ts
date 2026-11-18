import { randomBytes } from 'node:crypto';

/**
 * A password nobody knows, for an account created by somebody else
 * (2026-11-18: admins no longer set or type passwords for anyone).
 *
 * The account is created with this, hashed like any other password, and the
 * person sets their own through the welcome email's one-time link (or
 * "Forgot password"). 48 random bytes is far beyond guessing, and the value
 * is never stored, logged or returned anywhere.
 */
export function unknownPassword(): string {
  return randomBytes(48).toString('base64url');
}
