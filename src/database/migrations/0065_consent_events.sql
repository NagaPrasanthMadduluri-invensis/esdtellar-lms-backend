-- 0065 - Consent log (PDPA / DPDP accountability).
--
-- users.consent_version and users.consented_at (0057) hold only the LATEST
-- acknowledgement, are overwritten on every re-prompt and are cleared by the
-- retention sweep. That cannot prove what a person agreed to and when, which is
-- what a regulator or a client asks for. This table is the append-only history.
--
-- One row per event, never updated:
--   acknowledged          the person acknowledged notice <notice_version>
--   choice_changed        an optional choice moved (leaderboard visibility,
--                         email groups), with where it was changed in source
--   withdrawal_requested  a consent-withdrawal request was filed from My Data
--   withdrawal_resolved   an admin closed that request as actioned
--   withdrawal_rejected   an admin closed that request as refused
--
-- details is jsonb because each event carries a different small payload (the
-- choices snapshot, a data request id). Nothing filters on it.
--
-- ip_address and user_agent are the evidence of WHO clicked. They are personal
-- data, so the retention sweep nulls them when it anonymises the user while
-- keeping the row itself.
--
-- The backfill writes one acknowledged row per user who has already accepted a
-- notice, dated at their consented_at, so the history starts complete. It is
-- idempotent, guarded by NOT EXISTS on source = backfill.

CREATE TABLE IF NOT EXISTS consent_events (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event           text    NOT NULL,
  notice_version  text,
  details         jsonb,
  source          text,
  ip_address      text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_events_user
  ON consent_events (user_id, created_at DESC);

INSERT INTO consent_events (organization_id, user_id, event, notice_version, source, created_at)
SELECT u.organization_id, u.id, 'acknowledged', u.consent_version, 'backfill', u.consented_at
  FROM users u
 WHERE u.consented_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM consent_events ce
      WHERE ce.user_id = u.id AND ce.source = 'backfill'
   );
