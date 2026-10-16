-- 0054_direct_messages.sql
--
-- Direct messages: a two-way, per-person conversation between two people in the
-- same organization. The dashboard "Say hi" opens one; the Messages page is the
-- inbox and the thread.
--
-- Additive and idempotent. A message is ACTIVITY and carries organization_id,
-- read ONLY with orgScope (BACKEND_STRUCTURE.md 10.12) -- a conversation never
-- crosses a tenant boundary. A conversation is DERIVED (the set of messages
-- between two user ids), not a stored row: there is no conversations table,
-- because the pair of ids is the conversation and a second table would be the
-- same fact twice.
--
-- read_at is per-message and belongs to the RECIPIENT: NULL means they have not
-- opened the thread since it arrived. The unread badge counts NULLs addressed
-- to the caller, so the partial index below is the query that runs on every
-- poll.

CREATE TABLE IF NOT EXISTS direct_messages (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  sender_id       integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id    integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body            text    NOT NULL,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The unread badge: messages TO me not yet read. Partial, so it stays small.
CREATE INDEX IF NOT EXISTS idx_dm_recipient_unread
  ON direct_messages (recipient_id, organization_id)
  WHERE read_at IS NULL;

-- A thread is messages in BOTH directions between two people; one index per
-- direction keyed by time so the thread reads in order and the inbox can find
-- each conversation's latest message.
CREATE INDEX IF NOT EXISTS idx_dm_sender_recipient
  ON direct_messages (sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_recipient_sender
  ON direct_messages (recipient_id, sender_id, created_at DESC);
