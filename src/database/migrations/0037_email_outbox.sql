-- Transactional email: an outbox, a suppression list, per-user preferences
-- and one organization-level safety valve.
--
-- Additive and idempotent (§6.2). Nothing is backfilled and no existing row
-- changes meaning: an absent preference row means "everything on", and
-- `organizations.email_announcements` defaults to false, so the day this
-- migration runs the product behaves exactly as it did before.
--
-- =========================================================================
-- WHY AN OUTBOX TABLE AND NOT A JOB QUEUE
-- =========================================================================
--
-- `notify()` writing the bell row and publishing a job to a broker are two
-- systems. The transaction can roll back with the job already queued — an
-- email about something that never happened — or commit with the publish
-- lost, which is a silent drop. Neither is detectable afterwards.
--
-- An outbox row is a ROW, written by the same database as everything else,
-- so the dual-write problem does not exist. pg-boss sits on top as the
-- SCHEDULER and the single-consumer lock; it is not the message store. This
-- table is the message store. Anyone reading `pg-boss.service.ts` and
-- wondering why jobs are not enqueued per email: that is why.
--
-- It is also why this is Postgres and not the Redis already on the box.
-- That Redis is configured as a cache — `appendonly no`, no save points —
-- so a restart loses every pending job. Postgres is already durable, already
-- backed up, and already here.
--
-- =========================================================================
-- THE OUTBOX ROW STANDS ALONE
-- =========================================================================
--
-- `notification_id` is NULLABLE and ON DELETE SET NULL. It is there for
-- forensics — "the learner says they got an email but no bell" is one query
-- — and for nothing else. A NOT NULL foreign key would be wrong three ways:
--
--   1. It would tie the two inserts into one transaction, so an outbox
--      failure would roll back the bell rows. That destroys §10.18's
--      contract that telling somebody about a thing is secondary to the
--      thing itself.
--   2. The lifecycles differ. A notification is unread then read, forever.
--      An email is pending -> sending -> sent|failed|suppressed and then
--      becomes a delivery audit record, which support and deliverability
--      both need long after the bell row stops mattering.
--   3. Some emails have no bell at all. A password reset must not write a
--      notification: the recipient is not signed in, and a row announcing
--      that a reset was requested is a disclosure in itself.
--
-- =========================================================================
-- to_email AND org_name ARE FROZEN AT ENQUEUE
-- =========================================================================
--
-- The same reasoning that denormalises `actor_name` onto `notifications`.
-- Joining to `users.email` at send time means a learner who corrects their
-- address silently retargets mail that was already queued for the old one —
-- and worse, the delivery log can no longer say where the message actually
-- went. A delivery record that cannot answer "who did we send this to" is
-- not a delivery record.

CREATE TABLE IF NOT EXISTS email_outbox (
  id                  BIGSERIAL PRIMARY KEY,

  organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Forensics only. See the header.
  notification_id     INTEGER REFERENCES notifications(id) ON DELETE SET NULL,

  -- A notification catalogue key, or a direct type such as 'password_reset'
  -- that has no bell counterpart. Deliberately free text rather than an
  -- enum: the catalogue lives in TypeScript and a CHECK here would be a
  -- second list to keep in step.
  type                TEXT NOT NULL,

  -- Frozen at enqueue, because the per-type policy may be edited later and
  -- a row must be sent under the rules it was accepted under.
  policy              TEXT NOT NULL,

  to_email            TEXT NOT NULL,
  to_name             TEXT,
  org_name            TEXT,

  subject             TEXT NOT NULL,
  body                TEXT,
  -- Relative, exactly as stored on the bell row. Made absolute against
  -- CLIENT_ORIGIN at render time, never here.
  link                TEXT,
  actor_name          TEXT,

  -- Guards against the SAME application event being enqueued twice: a
  -- double-clicked Save, a retried request. See the service for the shape.
  dedupe_key          TEXT NOT NULL,

  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at          TIMESTAMPTZ,
  last_error          TEXT,
  -- The SES MessageId. The ONLY key that correlates an SNS bounce or
  -- complaint event back to the row that caused it.
  provider_message_id TEXT,

  enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ,

  CONSTRAINT email_outbox_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  CONSTRAINT email_outbox_policy_check
    CHECK (policy IN ('transactional', 'announcement'))
);

-- The indexes are PARTIAL, the same instinct as idx_notifications_unread:
-- every hot predicate covers a tiny slice of a table that grows forever.

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_outbox_dedupe
  ON email_outbox (dedupe_key);

-- The claim query, run once a minute forever. The one worth indexing well.
CREATE INDEX IF NOT EXISTS idx_email_outbox_claimable
  ON email_outbox (next_attempt_at, id)
  WHERE status = 'pending';

-- The reaper: rows whose worker died mid-send.
CREATE INDEX IF NOT EXISTS idx_email_outbox_stuck
  ON email_outbox (claimed_at)
  WHERE status = 'sending';

-- The daily budget count, also once a minute.
CREATE INDEX IF NOT EXISTS idx_email_outbox_daily
  ON email_outbox (sent_at)
  WHERE status = 'sent';

-- "What did we send this person?" — the support query.
CREATE INDEX IF NOT EXISTS idx_email_outbox_user
  ON email_outbox (user_id, enqueued_at DESC);

-- SNS event correlation.
CREATE INDEX IF NOT EXISTS idx_email_outbox_provider_msg
  ON email_outbox (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- =========================================================================
-- SUPPRESSIONS ARE GLOBAL, AND THAT IS DELIBERATE
-- =========================================================================
--
-- No organization_id and no user_id. A hard bounce is a fact about an
-- ADDRESS, not about a tenant or an account — the same address at two
-- tenants bounces at both, and a mailbox that rejected us yesterday will
-- reject us today whoever is asking.
--
-- This outranks every user preference and every organization setting,
-- including transactional mail. It is what protects the sending reputation,
-- and a reputation is shared by every tenant on the domain.

CREATE TABLE IF NOT EXISTS email_suppressions (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT email_suppressions_reason_check
    CHECK (reason IN ('hard_bounce', 'complaint', 'manual'))
);

-- =========================================================================
-- PREFERENCES: THREE LEVERS, NOT A 100-CELL MATRIX
-- =========================================================================
--
-- 25 types x 4 audiences is a grid nobody fills in and nobody maintains,
-- and every new notification type would need a UI change. Instead:
--
--   all_off     honoured for EVERYTHING, transactional included. Partial
--               honouring makes the checkbox a lie, and a lie in a consent
--               UI is a worse problem than an annoyed learner. This is only
--               affordable because §10.18 already guarantees nothing in the
--               notification system may be the only way a person learns
--               something — the data is on their screens regardless. Email
--               inherits that, so "off" can mean off.
--
--   groups_off  honoured for `announcement` types only, keyed by the
--               catalogue's existing `group`. Five checkboxes. A 26th type
--               drops into an existing group with no UI change and no
--               migration, which is exactly why the key is the group and
--               not the type.
--
-- An ABSENT ROW means everything on, so there is no backfill here and no
-- insert for the users who already exist.

CREATE TABLE IF NOT EXISTS user_email_preferences (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  all_off    SMALLINT NOT NULL DEFAULT 0,
  groups_off TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- `groups_off` is a comma-delimited string rather than text[], to match the
-- way every other list in this schema is stored (`courses.tags`) and to keep
-- the Drizzle column a plain `text`. Five possible values; this is not a set
-- anything will ever need to index or join on.

-- =========================================================================
-- PASSWORD RESET
-- =========================================================================
--
-- Hashes, never tokens. This table is readable by anyone with database
-- access, and a plaintext reset token there is a standing account-takeover
-- primitive for every row in it — the same reasoning that makes
-- `users.password` a scrypt hash.
--
-- `used_at` rather than a DELETE, so a reset link that is clicked twice can
-- be told apart from one that never existed. The second click gets "this
-- link has already been used", which is a different and more useful sentence
-- than "invalid link".
--
-- There is deliberately NO user-facing enumeration here: the request route
-- answers identically whether or not the address exists (§5.3's rule for
-- login, applied to the other end of the same flow).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  requested_ip  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_password_reset_token_hash
  ON password_reset_tokens (token_hash);

-- Rate limiting reads this: "how many has this user asked for lately".
CREATE INDEX IF NOT EXISTS idx_password_reset_user
  ON password_reset_tokens (user_id, created_at DESC);

-- =========================================================================
-- THE ORGANIZATION-LEVEL SAFETY VALVE
-- =========================================================================
--
-- Defaults FALSE, and that default is the single thing standing between the
-- first production deploy and 500 unsolicited emails.
--
-- `announcement` types — a course opening for self-enrolment, a session
-- opening for booking — go to the WHOLE active learner population of a
-- tenant. That is defensible under PECR as business-to-business mail to a
-- corporate subscriber, so it is not a legal blocker. It is a deliverability
-- one: it is by some distance the message most likely to draw a spam
-- complaint, and complaints degrade the sending reputation for the other 24
-- types along with it.
--
-- So an organization is opted OUT until somebody deliberately opts it in,
-- one tenant at a time.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS email_announcements SMALLINT NOT NULL DEFAULT 0;
