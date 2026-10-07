import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

/** One row to write. Everything the interceptor resolved. */
export interface NewAuditEntry {
  organizationId: number | null;
  actorUserId: number | null;
  actorName: string;
  actorEmail: string | null;
  actorPortal: string | null;
  actorRole: string | null;
  impersonatorName: string | null;
  method: string;
  route: string;
  path: string;
  action: string;
  entity: string | null;
  entityId: number | null;
  statusCode: number;
  outcome: 'success' | 'failure';
  errorMessage: string | null;
  summary: unknown | null;
  ip: string | null;
  durationMs: number | null;
}

export interface AuditFilters {
  /** NULL means every organization — platform reads only. */
  organizationId: number | null;
  actorUserId?: number | null;
  actorPortal?: string | null;
  action?: string | null;
  entity?: string | null;
  outcome?: string | null;
  from?: string | null;
  to?: string | null;
  /** Matches the actor's name, the path, or the entity. */
  q?: string | null;
  limit: number;
  offset: number;
}

/**
 * EVERY query here is raw SQL naming snake_case columns, with no Drizzle
 * `.select()` anywhere.
 *
 * That is deliberate and it is the §10.10 defect being designed out rather
 * than fixed for an eighth time: a repository that mixes `.select()`
 * (camelCase) with raw SQL (snake_case) hands the same row out under two
 * different key sets depending on which method produced it, and every
 * occurrence of that has been silent. One casing, no exceptions.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async record(entry: NewAuditEntry): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO audit_log (
        organization_id, actor_user_id, actor_name, actor_email,
        actor_portal, actor_role, impersonator_name,
        method, route, path, action, entity, entity_id,
        status_code, outcome, error_message, summary, ip, duration_ms
      ) VALUES (
        ${entry.organizationId}, ${entry.actorUserId}, ${entry.actorName}, ${entry.actorEmail},
        ${entry.actorPortal}, ${entry.actorRole}, ${entry.impersonatorName},
        ${entry.method}, ${entry.route}, ${entry.path}, ${entry.action}, ${entry.entity}, ${entry.entityId},
        ${entry.statusCode}, ${entry.outcome}, ${entry.errorMessage},
        ${entry.summary === null ? null : JSON.stringify(entry.summary)}::jsonb,
        ${entry.ip}, ${entry.durationMs}
      )
    `);
  }

  /**
   * The predicate, built once and shared by the page, the count and the
   * filter options — so the three can never describe different sets.
   *
   * `organizationId: null` means CROSS-TENANT and is reachable only from the
   * `@PlatformAdmin()` controller. The org controller always passes its own
   * scope's id, which comes from the verified token, so a tenant cannot ask
   * for another tenant's rows by any parameter.
   */
  private predicate(f: AuditFilters) {
    const parts = [sql`1 = 1`];
    if (f.organizationId !== null) parts.push(sql`a.organization_id = ${f.organizationId}`);
    if (f.actorUserId)  parts.push(sql`a.actor_user_id = ${f.actorUserId}`);
    if (f.actorPortal)  parts.push(sql`a.actor_portal = ${f.actorPortal}`);
    if (f.action)       parts.push(sql`a.action = ${f.action}`);
    if (f.entity)       parts.push(sql`a.entity = ${f.entity}`);
    if (f.outcome)      parts.push(sql`a.outcome = ${f.outcome}`);
    if (f.from)         parts.push(sql`a.created_at >= ${f.from}::timestamptz`);
    if (f.to)           parts.push(sql`a.created_at <= ${f.to}::timestamptz`);
    if (f.q) {
      const like = `%${f.q}%`;
      parts.push(sql`(a.actor_name ILIKE ${like} OR a.path ILIKE ${like} OR a.entity ILIKE ${like})`);
    }
    return sql.join(parts, sql` AND `);
  }

  async list(f: AuditFilters) {
    const rows = await this.db.execute(sql`
      SELECT a.id, a.organization_id, o.name AS organization_name,
             a.actor_user_id, a.actor_name, a.actor_email,
             a.actor_portal, a.actor_role, a.impersonator_name,
             a.method, a.route, a.path, a.action, a.entity, a.entity_id,
             a.status_code, a.outcome, a.error_message, a.summary,
             a.ip, a.duration_ms, a.created_at
        FROM audit_log a
        LEFT JOIN organizations o ON o.id = a.organization_id
       WHERE ${this.predicate(f)}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ${f.limit} OFFSET ${f.offset}
    `);
    return rows.rows as Record<string, unknown>[];
  }

  async count(f: AuditFilters): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT count(*)::int AS n FROM audit_log a WHERE ${this.predicate(f)}
    `);
    return Number((rows.rows[0] as { n: number })?.n ?? 0);
  }

  /**
   * The counts the page prints above the table, from ONE statement over the
   * same predicate — never four COUNT(*) queries beside it, which is how a
   * tile comes to disagree with the table underneath (§10.12 records the
   * same instinct for the Manage Users KPIs).
   */
  async summary(f: AuditFilters) {
    const rows = await this.db.execute(sql`
      SELECT count(*)::int                                                   AS total,
             count(*) FILTER (WHERE a.outcome = 'failure')::int              AS failures,
             count(*) FILTER (WHERE a.action  = 'create')::int               AS creates,
             count(*) FILTER (WHERE a.action  = 'update')::int               AS updates,
             count(*) FILTER (WHERE a.action  = 'delete')::int               AS deletes,
             count(DISTINCT a.actor_user_id)::int                            AS actors
        FROM audit_log a
       WHERE ${this.predicate(f)}
    `);
    return rows.rows[0] as Record<string, number>;
  }

  /**
   * What the filter controls may offer — the values actually PRESENT, not a
   * hardcoded list. A dropdown offering an entity nothing has ever written
   * is a filter that returns nothing and tells the reader they looked wrong.
   */
  async options(organizationId: number | null) {
    const orgPred = organizationId === null
      ? sql`1 = 1`
      : sql`a.organization_id = ${organizationId}`;

    const [entities, actors, orgs] = await Promise.all([
      this.db.execute(sql`
        SELECT DISTINCT a.entity FROM audit_log a
         WHERE ${orgPred} AND a.entity IS NOT NULL ORDER BY a.entity
      `),
      this.db.execute(sql`
        SELECT a.actor_user_id AS id, a.actor_name AS name,
               max(a.actor_portal) AS portal, count(*)::int AS actions
          FROM audit_log a
         WHERE ${orgPred} AND a.actor_user_id IS NOT NULL
         GROUP BY a.actor_user_id, a.actor_name
         ORDER BY count(*) DESC LIMIT 200
      `),
      organizationId === null
        ? this.db.execute(sql`
            SELECT DISTINCT a.organization_id AS id, o.name
              FROM audit_log a JOIN organizations o ON o.id = a.organization_id
             ORDER BY o.name
          `)
        : Promise.resolve({ rows: [] as Record<string, unknown>[] }),
    ]);

    return {
      entities: entities.rows.map((r) => (r as { entity: string }).entity),
      actors: actors.rows as Record<string, unknown>[],
      organizations: orgs.rows as Record<string, unknown>[],
    };
  }
}
