import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';
import { idList } from '@/database/id-list';

export interface IncidentRow {
  id: number;
  ref_no: string;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  discovered_at: string;
  assessment: string;
  assessed_at: string | null;
  data_categories: string | null;
  individuals_affected: number | null;
  cause: string | null;
  containment: string | null;
  clients_notified_at: string | null;
  regulator_notified_at: string | null;
  regulator_reference: string | null;
  individuals_notified_at: string | null;
  closed_at: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  organizations: Array<{ id: number; name: string }>;
}

/** Columns the service may write, in snake_case, as the table names them. */
export type IncidentWrite = Partial<{
  title: string;
  description: string | null;
  severity: string;
  status: string;
  discovered_at: string;
  assessment: string;
  assessed_at: string | null;
  data_categories: string | null;
  individuals_affected: number | null;
  cause: string | null;
  containment: string | null;
  clients_notified_at: string | null;
  regulator_notified_at: string | null;
  regulator_reference: string | null;
  individuals_notified_at: string | null;
  closed_at: string | null;
}>;

/**
 * The incident register (0066). Platform data, so no tenancy predicate here:
 * the only caller is IncidentsService behind @PlatformAdmin routes.
 *
 * Raw SQL throughout, so every row is snake_case (the §10.10 casing rule).
 * The affected organizations ride on each row as a json_agg, so the list is
 * one query (§7.1).
 */
@Injectable()
export class IncidentsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  private select(where: SQL): SQL {
    return sql`
      SELECT i.id, i.ref_no, i.title, i.description, i.severity, i.status,
             i.discovered_at, i.assessment, i.assessed_at, i.data_categories,
             i.individuals_affected, i.cause, i.containment,
             i.clients_notified_at, i.regulator_notified_at,
             i.regulator_reference, i.individuals_notified_at, i.closed_at,
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS created_by_name,
             i.created_at, i.updated_at,
             COALESCE((
               SELECT json_agg(json_build_object('id', o.id, 'name', o.name) ORDER BY o.name)
                 FROM security_incident_organizations sio
                 JOIN organizations o ON o.id = sio.organization_id
                WHERE sio.incident_id = i.id
             ), '[]'::json) AS organizations
        FROM security_incidents i
        LEFT JOIN users u ON u.id = i.created_by
       WHERE ${where}
    `;
  }

  async list(): Promise<IncidentRow[]> {
    return this.db.all<IncidentRow>(
      sql`${this.select(sql`TRUE`)} ORDER BY i.discovered_at DESC, i.id DESC`,
    );
  }

  async findById(id: number): Promise<IncidentRow | null> {
    const rows = await this.db.all<IncidentRow>(this.select(sql`i.id = ${id}`));
    return rows[0] ?? null;
  }

  /** INC-YYYY-NNNN, from the highest suffix this year (REF- numbering's shape). */
  async nextRefNo(year: number): Promise<string> {
    const prefix = `INC-${year}-`;
    const [row] = await this.db.all<{ n: number | null }>(sql`
      SELECT MAX(NULLIF(regexp_replace(ref_no, '^.*-', ''), '')::int) AS n
        FROM security_incidents
       WHERE ref_no LIKE ${prefix + '%'}
    `);
    return `${prefix}${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
  }

  async create(input: IncidentWrite & { ref_no: string; created_by: number }): Promise<number> {
    const [row] = await this.db.all<{ id: number }>(sql`
      INSERT INTO security_incidents
        (ref_no, title, description, severity, status, discovered_at,
         data_categories, individuals_affected, cause, containment, created_by)
      VALUES
        (${input.ref_no}, ${input.title}, ${input.description ?? null},
         ${input.severity ?? 'medium'}, ${input.status ?? 'open'}, ${input.discovered_at},
         ${input.data_categories ?? null}, ${input.individuals_affected ?? null},
         ${input.cause ?? null}, ${input.containment ?? null}, ${input.created_by})
      RETURNING id
    `);
    return row.id;
  }

  /**
   * Field-by-field: only keys PRESENT in `patch` are written, so a column the
   * caller did not name is never touched. The column names come from the
   * IncidentWrite type's keys, a fixed set, never from caller input.
   */
  async update(id: number, patch: IncidentWrite): Promise<void> {
    const allowed: Array<keyof IncidentWrite> = [
      'title', 'description', 'severity', 'status', 'discovered_at', 'assessment',
      'assessed_at', 'data_categories', 'individuals_affected', 'cause', 'containment',
      'clients_notified_at', 'regulator_notified_at', 'regulator_reference',
      'individuals_notified_at', 'closed_at',
    ];
    const sets = allowed
      .filter((k) => patch[k] !== undefined)
      .map((k) => sql`${sql.identifier(k)} = ${patch[k] as string | number | null}`);
    if (sets.length === 0) return;
    await this.db.run(sql`
      UPDATE security_incidents
         SET ${sql.join(sets, sql`, `)}, updated_at = now()
       WHERE id = ${id}
    `);
  }

  /** Replace the affected organizations. Unknown ids are ignored by the join. */
  async setOrganizations(incidentId: number, organizationIds: number[]): Promise<void> {
    await this.db.run(sql`DELETE FROM security_incident_organizations WHERE incident_id = ${incidentId}`);
    if (organizationIds.length === 0) return;
    await this.db.run(sql`
      INSERT INTO security_incident_organizations (incident_id, organization_id)
      SELECT ${incidentId}, o.id FROM organizations o WHERE o.id IN ${idList(organizationIds)}
      ON CONFLICT DO NOTHING
    `);
  }

  async addEvent(input: {
    incidentId: number;
    actorUserId: number | null;
    actorName: string | null;
    kind: string;
    note: string | null;
  }): Promise<void> {
    await this.db.run(sql`
      INSERT INTO security_incident_events (incident_id, actor_user_id, actor_name, kind, note)
      VALUES (${input.incidentId}, ${input.actorUserId}, ${input.actorName}, ${input.kind}, ${input.note})
    `);
  }

  async events(incidentId: number) {
    return this.db.all<{
      id: number; kind: string; note: string | null; actor_name: string | null; created_at: string;
    }>(sql`
      SELECT id, kind, note, actor_name, created_at
        FROM security_incident_events
       WHERE incident_id = ${incidentId}
       ORDER BY created_at DESC, id DESC
    `);
  }

  /** Organizations that can be named on an incident: every tenant, not the platform. */
  async organizationOptions() {
    return this.db.all<{ id: number; name: string }>(sql`
      SELECT id, name FROM organizations WHERE is_platform = false ORDER BY name
    `);
  }
}
