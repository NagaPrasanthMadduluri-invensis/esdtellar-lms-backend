/**
 * Consent capture (0057) — the one place the current privacy-notice version
 * lives, and the single rule for whether a person must accept it.
 *
 * Raising `CURRENT_PRIVACY_VERSION` re-prompts EVERYONE on their next sign-in,
 * with no migration and no backfill: a stored `consent_version` that is not the
 * current one is treated exactly like no consent at all. Use a date so the
 * history is legible; the value is opaque to the check.
 *
 * `client/lib/consent.js` mirrors `CURRENT_PRIVACY_VERSION` so the consent page
 * can show which version it is recording. Change both.
 */
export const CURRENT_PRIVACY_VERSION = '2026-10-22';

/**
 * The path of the public privacy-policy page, referenced from the consent
 * screen, the My Data page and the data-request emails. Relative here; the
 * email builder makes it absolute against `clientOrigin`, and the client links
 * to it directly. Mirrored in `client/lib/consent.js`.
 */
export const PRIVACY_POLICY_URL = '/privacy';

/**
 * Whether the caller must accept the current notice before using the app.
 *
 * True when they have never consented, or consented to an older version.
 */
export function isConsentRequired(
  consentVersion: string | null | undefined,
  consentedAt: string | null | undefined,
): boolean {
  if (!consentedAt) return true;
  return consentVersion !== CURRENT_PRIVACY_VERSION;
}
