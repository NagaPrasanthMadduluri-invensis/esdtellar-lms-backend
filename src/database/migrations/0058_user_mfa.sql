-- Admin MFA (TOTP): a time-based one-time-password second factor for
-- admin-portal accounts, with single-use recovery codes.
--
-- Additive and idempotent (§6.2). One new table.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE SECRET IS ENCRYPTED AT REST
-- ─────────────────────────────────────────────────────────────────────────
-- `secret` holds the TOTP shared secret encrypted with AES-256-GCM under
-- MFA_ENCRYPTION_KEY (never the DB, never the app bundle) — see
-- common/crypto/secret-box.util.ts. A plaintext TOTP secret in a table is a
-- standing second-factor bypass for every row, the same reasoning that keeps
-- users.password a scrypt hash and password_reset_tokens a SHA-256 hash.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ENROLLED vs ENABLED
-- ─────────────────────────────────────────────────────────────────────────
-- A row with `enabled_at IS NULL` is a PENDING enrolment: the secret is stored
-- but the user has not yet proved they can generate a code, so login does not
-- challenge them. `enabled_at` is set the moment they verify a first code, and
-- only then do the recovery codes exist and login require a second factor.
--
-- `recovery_codes` is a jsonb array of { hash, used_at } — the codes themselves
-- are SHA-256 hashed (high-entropy, so a fast hash is correct, like a reset
-- token), shown to the user exactly once at enable time, and each consumable
-- once.

CREATE TABLE IF NOT EXISTS user_mfa (
  user_id        integer PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- AES-256-GCM ciphertext (base64: iv | tag | ciphertext). Never plaintext.
  secret         text    NOT NULL,
  -- NULL = pending enrolment; a timestamp = active second factor.
  enabled_at     timestamptz,
  -- jsonb array of { "hash": <sha256 hex>, "used_at": <timestamptz|null> }.
  recovery_codes jsonb   NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
