-- Journeys: the indexes and tenancy foreign keys 0015 left off.
--
-- Two gaps found in review, both additive and therefore safe on boot:
--
-- 1. INDEXES. journey_enrollments is filtered by journey_id on every admin
--    "who is on this path" read, but its UNIQUE is (user_id, journey_id) —
--    leftmost user_id, so it does not serve that lookup. certificates is
--    filtered by journey_id on every journey completion, to decide whether the
--    certificate already exists.
--
-- 2. TENANCY FOREIGN KEYS. specs/multi-tenancy.md 3.5 makes the user axis
--    database-enforced: every activity table carries a composite
--    FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)
--    so a row can never name a user from another tenant, whatever the
--    application does. scripts/migrate-tenancy.mjs applied that to all 21
--    tables that existed then. The four journeys tables opted out by being
--    created afterwards. They are still small, so adding it now is cheap.
--
-- ADD CONSTRAINT is not itself idempotent, hence the DO blocks. Everything
-- here is safe to re-run.

CREATE INDEX IF NOT EXISTS idx_je_journey ON journey_enrollments (journey_id);
CREATE INDEX IF NOT EXISTS idx_certificates_journey ON certificates (journey_id);
CREATE INDEX IF NOT EXISTS idx_journey_courses_journey_order
  ON journey_courses (journey_id, sort_order);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journeys_organization') THEN
    ALTER TABLE journeys ADD CONSTRAINT fk_journeys_organization
      FOREIGN KEY (organization_id) REFERENCES organizations (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journey_courses_organization') THEN
    ALTER TABLE journey_courses ADD CONSTRAINT fk_journey_courses_organization
      FOREIGN KEY (organization_id) REFERENCES organizations (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journey_enrollments_organization') THEN
    ALTER TABLE journey_enrollments ADD CONSTRAINT fk_journey_enrollments_organization
      FOREIGN KEY (organization_id) REFERENCES organizations (id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_badges_organization') THEN
    ALTER TABLE user_badges ADD CONSTRAINT fk_user_badges_organization
      FOREIGN KEY (organization_id) REFERENCES organizations (id);
  END IF;

  -- The composite user FK: the structural guarantee that an activity row
  -- cannot name a learner from another tenant.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_journey_enrollments_org_user') THEN
    ALTER TABLE journey_enrollments ADD CONSTRAINT fk_journey_enrollments_org_user
      FOREIGN KEY (organization_id, user_id)
      REFERENCES users (organization_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_badges_org_user') THEN
    ALTER TABLE user_badges ADD CONSTRAINT fk_user_badges_org_user
      FOREIGN KEY (organization_id, user_id)
      REFERENCES users (organization_id, id) ON DELETE CASCADE;
  END IF;
END $$;
