-- ─────────────────────────────────────────────────────────────────────────
-- 0040 — The organization's logo travels with the queued email
--
-- Emails now lead with the TENANT's name and mark rather than the product's,
-- so a learner at Invensis gets an Invensis email. The name was already
-- frozen onto the outbox row at enqueue (0037 argues why); the logo has to
-- travel the same way, for the same reason.
--
-- ## Frozen, not joined
--
-- It would be less code to join `organizations` when the worker sends. It
-- would also be wrong. The queue is drained minutes to hours after the row
-- is written, and an organization that changes its logo in between would
-- have every queued message silently re-branded — including messages about
-- events that happened under the old mark. Worse, the delivery log would
-- stop being able to say what was actually sent.
--
-- Exactly the reasoning 0037 gives for `to_email` and `org_name`: a queued
-- message is a record of what we decided to send, not a template to be
-- re-evaluated later.
--
-- ## Nullable, and null is the common case
--
-- Most organizations have no logo. The layout falls back to the product
-- wordmark rather than leaving a gap, so nothing needs backfilling and
-- every existing queued row keeps rendering exactly as it does today.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE email_outbox
  ADD COLUMN IF NOT EXISTS org_logo_url text;
