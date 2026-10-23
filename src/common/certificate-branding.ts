import { createHash, randomBytes } from 'node:crypto';

/**
 * How a tenant's certificate code is prefixed.
 *
 * `organizations.certificate_prefix` replaces the built-in `EDS`, so
 * Invensis issues `INV-19-18-…` rather than `EDS-19-18-…`.
 *
 * ## NULL means "use the default", not "unset"
 *
 * An organization that has never expressed a preference stays NULL and
 * follows `DEFAULT_CERTIFICATE_PREFIX`. Backfilling every row with 'EDS'
 * would look identical today and would quietly freeze the default for
 * tenants that never chose it — the distinction is only expressible as NULL
 * (0038 argues this).
 *
 * ## The prefix is never applied retroactively
 *
 * A code is printed on a document somebody already holds, and it is exactly
 * what `GET /api/certificates/verify/:code` takes. This is read when a code
 * is GENERATED and at no other time. Nothing in the codebase parses a code,
 * so old and new prefixes verify alike.
 */

export const DEFAULT_CERTIFICATE_PREFIX = 'EDS';

/** Longest a prefix may be. Beyond this the code stops being scannable. */
export const CERTIFICATE_PREFIX_MAX = 10;
export const CERTIFICATE_PREFIX_MIN = 2;

/**
 * The character rule, and it is narrow on purpose.
 *
 * A code is read aloud down a phone line, typed into a verify box and
 * printed in a footer. Letters and digits only, upper case — no hyphen,
 * because the hyphen is the code's own separator and one inside the prefix
 * would make `AB-C-19-18-…` ambiguous about where the prefix ends.
 */
export const CERTIFICATE_PREFIX_PATTERN = /^[A-Z0-9]{2,10}$/;

/**
 * Normalises what an admin typed. Returns null for anything empty, which
 * the column stores as "follow the default".
 */
export function normaliseCertificatePrefix(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().toUpperCase();
  return text === '' ? null : text;
}

/** The prefix to actually use, falling back to the built-in default. */
export function certificatePrefix(stored?: string | null): string {
  const value = normaliseCertificatePrefix(stored);
  return value && CERTIFICATE_PREFIX_PATTERN.test(value)
    ? value
    : DEFAULT_CERTIFICATE_PREFIX;
}

/**
 * A short, scannable certificate code: the organisation's prefix followed by
 * random uppercase hex, TEN characters in all for the common 3- or 4-letter
 * prefix — `EDSA2F9BD3`, or `INVA2F9BD3` when a tenant sets its own.
 *
 * ## Length is `prefix + fill`, and the fill absorbs the prefix length
 *
 * A 3-letter prefix leaves 7 hex, a 4-letter prefix leaves 6 — both land on
 * ten. A longer prefix keeps the `MIN` floor of random rather than shrinking
 * to nothing, so the code stays unique at the cost of running past ten; the
 * admin UI keeps prefixes to the 2-4 the owner asked for, so that is the edge,
 * not the norm.
 *
 * ## Short codes trade entropy for a UNIQUE column, so the caller RETRIES
 *
 * The old code carried 12 hex precisely because uniqueness rested entirely on
 * the hash. Ten characters cannot: 7 hex is 268M values, a birthday clash
 * around 16k certificates. The guarantee therefore moves OFF the entropy and
 * onto a generate-check-retry loop against the UNIQUE column (see
 * `CertificatesService.generateUniqueCode`): on the rare clash we simply mint
 * another. That is why this returns a candidate, not a promise of uniqueness.
 */
export const CERTIFICATE_CODE_LENGTH = 10;
export const CERTIFICATE_CODE_MIN_FILL = 6;

/** Random uppercase hex of `chars` length, from the CSPRNG. No ambiguous
 *  glyphs — hex has no O/0 or I/1 to misread down a phone line. */
function randomHex(chars: number): string {
  return randomBytes(Math.ceil(chars / 2))
    .toString('hex')
    .slice(0, chars)
    .toUpperCase();
}

/** A fresh candidate code for the given stored prefix (see the doc above). */
export function buildCertificateCode(stored?: string | null): string {
  const prefix = certificatePrefix(stored);
  const fill = Math.max(CERTIFICATE_CODE_LENGTH - prefix.length, CERTIFICATE_CODE_MIN_FILL);
  return `${prefix}${randomHex(fill)}`;
}

/**
 * How many hex characters of randomness a certificate code carries.
 *
 * TWELVE, and the number is load-bearing rather than a taste.
 *
 * `certificates.certificate_code` is UNIQUE NOT NULL. The code used to
 * embed the course and learner ids (`EDS-19-18-EFC3E4E1`), which made a
 * collision between two different certificates impossible no matter what
 * the hash did — the 8 hex characters beside them were decoration.
 *
 * Removing the ids moved the entire uniqueness guarantee onto the hash, and
 * 8 hex is only 4.3 billion values: by the birthday bound that is a coin
 * flip at about 77,000 certificates, and a collision is not a cosmetic
 * clash — the insert violates the constraint and a learner does not get
 * their certificate.
 *
 * 12 hex is 2.8e14. At a million certificates the chance of ANY collision
 * is roughly 0.0002%. The cost is four more characters on a line nobody
 * types from memory.
 */
export const CODE_HASH_CHARS = 12;

/**
 * The random half of a certificate code.
 *
 * `seed` only varies the input; the entropy is `randomBytes`. It is kept
 * because a seed makes two codes minted in the same millisecond differ even
 * if the RNG were somehow repeating, and it costs nothing.
 */
export function codeHash(seed: string): string {
  return createHash('sha256')
    .update(`${seed}:${Date.now()}:${randomBytes(16).toString('hex')}`)
    .digest('hex')
    .slice(0, CODE_HASH_CHARS)
    .toUpperCase();
}
