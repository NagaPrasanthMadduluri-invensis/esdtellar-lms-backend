-- Branch locations and job levels become PER-ORGANIZATION data, curated by
-- the platform admin at onboarding, replacing the hardcoded
-- `common/workforce.ts`.
--
-- Additive and idempotent (§6.2). Two tables plus a backfill.
--
-- ═════════════════════════════════════════════════════════════════════════
-- THIS REVERSES A DOCUMENTED DECISION, AND THE REASON IT IS SAFE
-- ═════════════════════════════════════════════════════════════════════════
--
-- TASTE §10.3.1.1 argued that `location` and `job_level` must be closed code
-- catalogues with NO table behind them, because "a table would let an org
-- invent a value, which is exactly what makes `job_role` useless". The point
-- stands: a reporting dimension is worth nothing if its values do not repeat
-- across people.
--
-- What changes is WHO curates the list, not whether it is curated. These
-- tables are written by `@PlatformAdmin()` routes only; an organization admin
-- READS its own list and can pick from it, exactly as they picked from the
-- constant before. So the values still repeat, the dimension still works, and
-- Edstellar gains the thing the constant could not give: a tenant in Dubai
-- whose offices are not in a nine-city Indian list.
--
-- ═════════════════════════════════════════════════════════════════════════
-- `users.location` AND `users.job_level` STAY `text`. NO FOREIGN KEY.
-- ═════════════════════════════════════════════════════════════════════════
--
-- This is the load-bearing decision and it is deliberate.
--
--   * The reports builder filters and groups on those two columns directly
--     (§10.12). A foreign key would mean rewriting every one of those queries
--     through a join, for no gain — the report needs the NAME, which is what
--     the column already holds.
--   * An FK would make this migration non-additive: every existing value
--     would have to resolve to a row before the constraint could be added, and
--     anything that did not match would have to be destroyed or the migration
--     would fail. §6.2 calls that a human checkpoint, not a boot migration.
--   * Renaming a branch should not silently rewrite history. Somebody recorded
--     as working in "Bangalore" in 2024 still worked in Bangalore after the
--     office is renamed.
--
-- So these tables supply the OPTIONS a form may offer. They do not own the
-- values already on people.

CREATE TABLE IF NOT EXISTS organization_locations (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  -- What goes into `users.location`. The city name alone, because that is
  -- what the column holds today and what every existing report groups by.
  name            text    NOT NULL,
  -- Where it came from, for display only: "Karnataka, India".
  country_code    text,
  country_name    text,
  state_name      text,
  -- Retiring a branch must not invalidate the people recorded against it, so
  -- this hides it from NEW selections rather than deleting the row.
  is_active       integer NOT NULL DEFAULT 1,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One branch of a given name per org. A second "Chennai" is a data-entry slip,
-- and two identical options in a dropdown is the ambiguity these lists exist
-- to remove.
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_locations_unique
  ON organization_locations (organization_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_org_locations_org
  ON organization_locations (organization_id, sort_order);

CREATE TABLE IF NOT EXISTS organization_job_levels (
  id              serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            text    NOT NULL,
  -- Seniority, so the dropdown reads Executive-to-Intern rather than
  -- alphabetically. The constant carried this implicitly in its array order;
  -- a table has no order unless one is stored.
  sort_order      integer NOT NULL DEFAULT 0,
  is_active       integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_job_levels_unique
  ON organization_job_levels (organization_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_org_job_levels_org
  ON organization_job_levels (organization_id, sort_order);

-- ═════════════════════════════════════════════════════════════════════════
-- BACKFILL — every value already IN USE, plus the old defaults
-- ═════════════════════════════════════════════════════════════════════════
--
-- Without this the lists start empty and every existing learner's location
-- becomes unselectable: their stored value is still in `users.location` and
-- still groups in reports, but no form could ever set it again and the filter
-- would offer options that match nobody. That is the silent-omission failure
-- §10.12 records for the two legacy location spellings, reintroduced on
-- purpose. So the backfill takes the DISTINCT values actually present per
-- organization first.

INSERT INTO organization_locations (organization_id, name, country_code, country_name)
SELECT DISTINCT u.organization_id, u.location, 'IN', 'India'
  FROM users u
 WHERE u.location IS NOT NULL AND btrim(u.location) <> ''
ON CONFLICT DO NOTHING;

INSERT INTO organization_job_levels (organization_id, name, sort_order)
SELECT DISTINCT u.organization_id, u.job_level,
       -- The constant's own order, preserved. Anything unrecognised sorts
       -- last rather than being dropped.
       CASE u.job_level
         WHEN 'Executive' THEN 1 WHEN 'Senior' THEN 2 WHEN 'Manager' THEN 3
         WHEN 'Mid' THEN 4 WHEN 'Junior' THEN 5 WHEN 'Intern' THEN 6
         ELSE 99 END
  FROM users u
 WHERE u.job_level IS NOT NULL AND btrim(u.job_level) <> ''
ON CONFLICT DO NOTHING;

-- Then the old constants, so an org that has not used a value yet still gets
-- the list it had before this change. ON CONFLICT keeps whatever the step
-- above already inserted.
INSERT INTO organization_job_levels (organization_id, name, sort_order)
SELECT o.id, v.name, v.sort_order
  FROM organizations o
 CROSS JOIN (VALUES
   ('Executive', 1), ('Senior', 2), ('Manager', 3),
   ('Mid', 4), ('Junior', 5), ('Intern', 6)
 ) AS v(name, sort_order)
 WHERE NOT o.is_platform
ON CONFLICT DO NOTHING;
