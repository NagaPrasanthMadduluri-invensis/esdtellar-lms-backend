-- Per-person notifications, with an unread badge.
--
-- Additive and idempotent (§6.2). One table.
--
-- ═════════════════════════════════════════════════════════════════════════
-- WHY THIS IS NOT `activity_log`
-- ═════════════════════════════════════════════════════════════════════════
--
-- The two look alike and answer different questions, and folding them
-- together would break both:
--
--   * `activity_log` is ONE row per event, scoped to an organization, read as
--     a feed on the admin dashboard. It has no recipient — everybody in the
--     org sees the same list — and no read state.
--   * a notification is addressed to ONE PERSON and carries whether THEY have
--     seen it. "Course assigned" is one activity row and fifteen
--     notifications, one per learner, each with its own `read_at`.
--
-- Putting read state on `activity_log` would need a join table keyed by
-- (row, user) — which is this table, with extra steps and a feed nobody
-- asked to personalise.
--
-- ═════════════════════════════════════════════════════════════════════════
-- `read_at`, NOT a boolean
-- ═════════════════════════════════════════════════════════════════════════
--
-- WHEN somebody saw a notification is worth more than THAT they saw it: it is
-- the difference between "they have known for a month" and "they saw it after
-- the deadline". A boolean throws that away and costs the same to store.
-- NULL means unread, and the unread badge is COUNT(*) over NULLs.

CREATE TABLE IF NOT EXISTS notifications (
  id              serial PRIMARY KEY,

  -- ACTIVITY, so `orgScope` and never `contentScope` (§10.12). A platform
  -- admin's notifications carry the platform org; a tenant's carry theirs.
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,

  -- The RECIPIENT. This is the column that makes it a notification rather
  -- than a feed entry. Their account going means their notifications go.
  user_id         integer NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  -- A key from `common/notifications.ts`, the catalogue-as-code. The label
  -- and icon are NOT stored: they are presentation, they change with copy
  -- edits, and storing them would freeze today's wording into every old row.
  type            text    NOT NULL,

  -- What the row says. `title` is the line in bold, `body` the sentence under
  -- it. Both are composed at write time because they name things — a course
  -- title, a learner's name — that may later be renamed or deleted, and a
  -- notification describing what happened THEN must not change afterwards.
  title           text    NOT NULL,
  body            text,

  -- Where clicking it goes. Nullable: some notifications are just news.
  -- Stored rather than derived from (subject_type, subject_id) because the
  -- right destination differs per portal — a learner opens their own course
  -- page, an admin opens the roster for the same course.
  link            text,

  -- What it is about, for grouping and for finding rows to clean up later.
  subject_type    text,
  subject_id      integer,

  -- Who caused it, denormalised. A join to `users` would drop the row
  -- entirely once that person is deleted (an INNER JOIN) or blank the name (a
  -- LEFT JOIN) — and "Anita assigned you a course" should still read that way
  -- after Anita leaves. Same choice `activity_log.actor_name` makes.
  actor_name      text,

  -- NULL = unread. See the header.
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The bell's list: this person's notifications, newest first.
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- The badge count. A PARTIAL index over unread rows only, so it stays small
-- no matter how much read history accumulates — this is the query that runs
-- on every page load in every portal, and it is the one worth indexing well.
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id)
  WHERE read_at IS NULL;
