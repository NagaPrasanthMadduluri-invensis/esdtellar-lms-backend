-- 0067 - Client offboarding deletion, and the extended retention sweep.
--
-- When a client leaves, Edstellar as their processor must delete or anonymise
-- their people's data after an agreed grace period (privacy-pack document 03,
-- section 7). A platform admin schedules it on the tenant once the tenant's
-- access is switched off. The worker's retention sweep does the rest on the
-- due date: it anonymises every person in the organization, then removes the
-- organization's messages, community content, notifications and logs.
--
-- data_deletion_due_at is when it may run. NULL means nothing is scheduled.
-- data_deleted_at records that it ran, so it never runs twice. Courses and
-- other content the client authored are not personal data and are kept.
--
-- The rest of the extended sweep (anonymising a person everywhere their name
-- was copied, and the time limits per category) needs no schema change.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS data_deletion_due_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS data_deleted_at      timestamptz;

CREATE INDEX IF NOT EXISTS idx_organizations_data_deletion
    ON organizations (data_deletion_due_at)
 WHERE data_deletion_due_at IS NOT NULL AND data_deleted_at IS NULL;
