-- Consent capture (PDPA Consent + Notification): record that a person has
-- accepted the current privacy notice, and when. The app gates the portals on
-- it after login, so a new or updated notice is acknowledged before use.
--
-- Additive and idempotent (§6.2). Two nullable columns on `users`, no backfill.
--
-- NULL `consented_at` means "has not consented to the current version" — which
-- is every existing user the moment this ships, so they are prompted once on
-- their next sign-in. `consent_version` records WHICH notice they accepted, so
-- raising CURRENT_PRIVACY_VERSION (common/consent.ts) re-prompts everyone
-- without a migration or a backfill. The notice COPY is a product/legal
-- artifact kept in the client; this only records the acceptance.

ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consented_at timestamptz;
