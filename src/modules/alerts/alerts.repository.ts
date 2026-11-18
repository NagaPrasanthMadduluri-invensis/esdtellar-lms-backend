import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '@/database/database.service';

/**
 * Queries behind the Cliq alerts (§10.50). Raw SQL, snake_case. Reads only
 * what an alert needs: timestamps and the incident fields the deadline clocks
 * are derived from. Never a name or an email.
 */
@Injectable()
export class AlertsRepository {
  constructor(private readonly database: DatabaseService) {}
  private get db() {
    return this.database.db;
  }

  async beat(name: string): Promise<void> {
    await this.db.run(sql`
      INSERT INTO system_heartbeats (name, beat_at) VALUES (${name}, now())
      ON CONFLICT (name) DO UPDATE SET beat_at = now()`);
  }

  /** Seconds since the named process last beat, or null if it never has. */
  async secondsSinceBeat(name: string): Promise<number | null> {
    const [row] = await this.db.all<{ s: number | null }>(sql`
      SELECT EXTRACT(EPOCH FROM (now() - beat_at))::int AS s
        FROM system_heartbeats WHERE name = ${name}`);
    return row ? Number(row.s) : null;
  }

  /** A trivial round trip, for the health check. */
  async ping(): Promise<boolean> {
    const [row] = await this.db.all<{ ok: number }>(sql`SELECT 1 AS ok`);
    return Number(row?.ok) === 1;
  }

  /** Open incidents, with the fields their deadline clocks are derived from. */
  async openIncidents() {
    return this.db.all<{
      id: number;
      ref_no: string;
      severity: string;
      discovered_at: string;
      assessment: string;
      assessed_at: string | null;
      clients_notified_at: string | null;
      regulator_notified_at: string | null;
      individuals_notified_at: string | null;
      affected_organizations: number;
    }>(sql`
      SELECT i.id, i.ref_no, i.severity, i.discovered_at, i.assessment, i.assessed_at,
             i.clients_notified_at, i.regulator_notified_at, i.individuals_notified_at,
             (SELECT count(*)::int FROM security_incident_organizations o WHERE o.incident_id = i.id)
               AS affected_organizations
        FROM security_incidents i
       WHERE i.status <> 'closed'`);
  }
}
