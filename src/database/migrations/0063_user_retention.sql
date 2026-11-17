-- Retention Limitation (PDPA #7): give a deactivated user's row a clock and a
-- tombstone marker so a scheduled sweep can ANONYMISE its PII after a window,
-- while keeping the row for referential integrity (certificates, completions,
-- attempts all still point at it). See modules/retention.
--
-- Additive + idempotent (runs on boot in filename order).

ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at  timestamptz;

-- Existing inactive users have no recorded deactivation time, and there is no
-- updated_at to approximate it. Start their retention clock at DEPLOY time
-- rather than retroactively: backfilling from created_at could anonymise a
-- long-tenured user the moment this ships. Conservative by construction.
UPDATE users
   SET deactivated_at = now()
 WHERE is_active = 0
   AND deactivated_at IS NULL;

-- The sweep's lookup: inactive, not yet anonymised, deactivated before a cutoff.
CREATE INDEX IF NOT EXISTS idx_users_retention
    ON users (deactivated_at)
 WHERE is_active = 0 AND anonymized_at IS NULL;
