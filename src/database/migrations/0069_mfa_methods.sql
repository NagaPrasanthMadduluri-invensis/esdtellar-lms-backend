-- 0069 - Two-step sign-in by email code, beside the authenticator app.
--
-- Each person chooses their method: 'totp' (an authenticator app) or 'email'
-- (a 6-digit code emailed at sign-in). Admins must have one of the two; it is
-- optional for everyone else (BACKEND_STRUCTURE 10.51).
--
-- user_mfa gains:
--   method          the ACTIVE method once enabled_at is set
--   pending_method  a method being set up but not yet confirmed
--   pending_secret  its encrypted TOTP secret (NULL for email)
-- so that switching method never removes the active protection until the new
-- one is confirmed. secret becomes nullable: an email method has no secret.
--
-- mfa_email_codes holds emailed codes ONLY as a keyed hash, never the code,
-- with an expiry, an attempt counter and a used stamp.
--
-- The backfill moves a half-finished authenticator setup into the pending
-- columns. Idempotent: it only touches rows not yet moved.

ALTER TABLE user_mfa ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'totp';
ALTER TABLE user_mfa ADD COLUMN IF NOT EXISTS pending_method text;
ALTER TABLE user_mfa ADD COLUMN IF NOT EXISTS pending_secret text;
ALTER TABLE user_mfa ALTER COLUMN secret DROP NOT NULL;

UPDATE user_mfa
   SET pending_method = 'totp', pending_secret = secret, secret = NULL
 WHERE enabled_at IS NULL AND pending_method IS NULL AND secret IS NOT NULL;

CREATE TABLE IF NOT EXISTS mfa_email_codes (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose    text    NOT NULL,
  code_hash  text    NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_email_codes_user
  ON mfa_email_codes (user_id, purpose, created_at DESC);
