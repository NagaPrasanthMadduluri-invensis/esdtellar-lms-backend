import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { orgScope, type OrgScope } from '@/database/org-scope';

/** One `SetValue` delta, already validated by the DTO. */
export interface DatamodelDelta {
  elementKey: string;
  elementValue: string | null;
}

export interface DatamodelLogEntry {
  id: number;
  attempt_number: number;
  element_key: string;
  element_value: string | null;
  created_at: string;
}

/**
 * Every query against `scorm_datamodel_log`.
 *
 * `orgScope`, never `contentScope`. A learner's runtime writes are ACTIVITY:
 * they always belong to that learner's own organization and are never global
 * content, so widening to `IN (org, platform)` here would be a genuine
 * cross-tenant leak rather than a feature (see the note in
 * `database/org-scope.ts`). Getting this wrong is exactly what
 * `npm run test:isolation` exists to catch.
 */
@Injectable()
export class ScormDatamodelRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Bulk-inserts a batch of deltas in ONE statement.
   *
   * A commit from a busy package carries dozens of elements, and one INSERT
   * per element would be one network round trip per element — the N+1 pattern
   * §7.1 forbids, on the hottest write path in the system. The whole batch
   * becomes a single multi-row VALUES list instead.
   *
   * `organization_id` comes from the verified scope on every row, never from
   * the payload. The client sends element keys and values; it does not get to
   * say which tenant they belong to (§5.3).
   *
   * `attempt_number` is resolved IN SQL from `scorm_attempts`, not passed in,
   * so a client cannot backdate a delta into a previous attempt. It is
   * `COUNT(*) + 1` of finished attempts, matching how `appendAttempt` numbers
   * them — deltas therefore land on the attempt currently in progress.
   *
   * Returns the number of rows written so the caller can report it rather
   * than assuming the batch landed whole.
   */
  async insertBatch(
    scope: OrgScope,
    userId: number,
    packageId: number,
    deltas: DatamodelDelta[],
  ): Promise<number> {
    if (deltas.length === 0) return 0;

    const values = sql.join(
      deltas.map(
        (delta) =>
          sql`(${scope.organizationId}, ${userId}, ${packageId},
               (SELECT COUNT(*) + 1 FROM scorm_attempts
                 WHERE user_id = ${userId} AND package_id = ${packageId}),
               ${delta.elementKey}, ${delta.elementValue}, now())`,
      ),
      sql`, `,
    );

    await this.db.run(sql`
      INSERT INTO scorm_datamodel_log
        (organization_id, user_id, package_id, attempt_number,
         element_key, element_value, created_at)
      VALUES ${values}
    `);

    return deltas.length;
  }

  /**
   * One learner's timeline on one package, newest first.
   *
   * Paginated because this table grows without bound per learner per package
   * (§7.6) — it is the one table here where an unbounded list would be
   * measured in thousands of rows within a single sitting.
   */
  async listForLearner(
    scope: OrgScope,
    userId: number,
    packageId: number,
    limit: number,
    offset: number,
  ): Promise<DatamodelLogEntry[]> {
    return this.db.all<DatamodelLogEntry>(sql`
      SELECT id, attempt_number, element_key, element_value, created_at
      FROM scorm_datamodel_log
      WHERE user_id = ${userId}
        AND package_id = ${packageId}
        AND ${orgScope('scorm_datamodel_log', scope)}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
  }

  /** Total rows for the same filter, so the caller can render a page count. */
  async countForLearner(
    scope: OrgScope,
    userId: number,
    packageId: number,
  ): Promise<number> {
    const rows = await this.db.all<{ total: number }>(sql`
      SELECT COUNT(*)::int AS total
      FROM scorm_datamodel_log
      WHERE user_id = ${userId}
        AND package_id = ${packageId}
        AND ${orgScope('scorm_datamodel_log', scope)}
    `);
    return rows[0]?.total ?? 0;
  }

  /**
   * The latest value of each element for one learner on one package — the
   * "current data model" reconstructed from the log.
   *
   * `DISTINCT ON` rather than a GROUP BY with a correlated subquery per key:
   * one index scan, one pass, no per-key round trip (§7.2 — aggregate in SQL).
   */
  async latestByElement(
    scope: OrgScope,
    userId: number,
    packageId: number,
  ): Promise<Array<{ element_key: string; element_value: string | null; created_at: string }>> {
    return this.db.all(sql`
      SELECT DISTINCT ON (element_key)
             element_key, element_value, created_at
      FROM scorm_datamodel_log
      WHERE user_id = ${userId}
        AND package_id = ${packageId}
        AND ${orgScope('scorm_datamodel_log', scope)}
      ORDER BY element_key, created_at DESC, id DESC
    `);
  }

  /**
   * One element across every learner on a package, for admin analytics —
   * e.g. every `cmi.interactions.3.learner_response`.
   *
   * The join to `users` is org-scoped as well as the log itself. Scoping only
   * the log would still be correct today, but a second predicate on the joined
   * table is what keeps it correct if this ever becomes a cross-package read.
   */
  async elementAcrossLearners(
    scope: OrgScope,
    packageId: number,
    elementKey: string,
    limit: number,
    offset: number,
  ) {
    return this.db.all(sql`
      SELECT l.user_id,
             u.first_name,
             u.last_name,
             l.attempt_number,
             l.element_value,
             l.created_at
      FROM scorm_datamodel_log l
      INNER JOIN users u
              ON u.id = l.user_id
             AND ${orgScope('u', scope)}
      WHERE l.package_id = ${packageId}
        AND l.element_key = ${elementKey}
        AND ${orgScope('l', scope)}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
  }
}
