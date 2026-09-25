-- A reporting line: users.manager_id.
--
-- Additive and idempotent (§6.2). One nullable column and one index.
--
-- =========================================================================
-- THIS REVERSES A DECISION, DELIBERATELY
-- =========================================================================
--
-- BACKEND_STRUCTURE §10.17 recorded why `manager` was left out when `phone`
-- went in: "there is no reporting line in this product - a Manager's scope is
-- a department, not a set of direct reports - so a manager_id would render as
-- an em dash forever". That was true of the product as it stood. The owner has
-- since asked for the reporting line itself, so the premise is gone rather
-- than the reasoning being wrong.
--
-- What changes with it: Team Learning stops meaning "my department" and starts
-- meaning "the people who report to me". Both were one query; only one of them
-- can be the answer, and two definitions of a team is how one manager ends up
-- seeing another's people.
--
-- =========================================================================
-- NULLABLE, AND ON DELETE SET NULL
-- =========================================================================
--
-- Nullable because most people have no manager recorded and the org chart is
-- filled in over time, never in one sitting. A NOT NULL column here would
-- need a fabricated default, and inventing a reporting line is worse than
-- admitting there is not one yet.
--
-- SET NULL rather than CASCADE, and the difference is the whole point:
-- deleting a manager must orphan their reports, never delete them. CASCADE on
-- a self-reference would take a manager's entire team with them, and then
-- their team's teams. That is a delete nobody would predict from the button
-- they pressed.
--
-- =========================================================================
-- NO CHECK CONSTRAINT FOR CYCLES
-- =========================================================================
--
-- `manager_id <> id` could be a CHECK, and a cycle of two (A manages B who
-- manages A) could not - that needs a recursive walk, which is a query, not a
-- constraint. Putting half the rule in the database and half in the service
-- would mean two places to read and one of them lying by omission. Both live
-- in `UsersService.assertManager`, which walks the chain before every write.
--
-- The index exists because `manager_id` is the entire WHERE clause of Team
-- Learning, which a manager loads on every visit (§7.4).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS manager_id integer
  REFERENCES users (id) ON DELETE SET NULL;

-- "Who reports to me" - Team Learning's whole predicate. Partial, because the
-- rows that matter are the ones with a manager and most rows have none.
CREATE INDEX IF NOT EXISTS idx_users_manager
  ON users (manager_id)
  WHERE manager_id IS NOT NULL;
