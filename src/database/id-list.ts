import { sql, type SQL } from 'drizzle-orm';

/**
 * A SQL list of ids, for `... IN ${idList(ids)}`.
 *
 * ## The quirk this exists for
 *
 * Interpolating a JavaScript array into a Drizzle `sql` template expands it
 * as a **ROW CONSTRUCTOR**, not a list — so `id IN ${[1,2,3]}` becomes
 * `id IN ((1,2,3))` and Postgres refuses it with *"operator does not exist:
 * integer = record"*. The `ANY()` spelling fails the same way, with
 * *"cannot cast type record to integer[]"*.
 *
 * ## Why it is here rather than copied a fifth time
 *
 * It was written separately in `courses`, `journeys` and `sessions`, and
 * BACKEND_STRUCTURE §10.15 ends its note on them with: *"Worth lifting into
 * `database/` the next time a fourth is needed."* A fourth was needed —
 * `PasswordResetRepository.issueMany` hit the identical error while
 * batching the bulk import's welcome tokens, and the symptom was a silent
 * one: the write is best-effort, so six accounts were created and nobody
 * was emailed, with only a `warn` to say so.
 *
 * Three copies is a coincidence; four is a missing utility.
 *
 * The explicit `::int` cast is load-bearing on an empty-ish comparison and
 * costs nothing otherwise. **Callers must not pass an empty array** — `IN
 * ()` is a syntax error in Postgres — so guard on length first; every
 * caller already returns early for an empty set.
 */
export function idList(ids: number[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}::int`), sql`, `)})`;
}
