import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from './database.service';

/**
 * The tables that carry a non-sequential `public_id` (migration 0046), the ones
 * whose id appears in a browser URL. This is a WHITELIST: a caller string is
 * never used as a table name, so there is no injection surface even though the
 * query names the table dynamically.
 */
const PUBLIC_ID_TABLES = {
  courses: 'courses',
  lessons: 'lessons',
  assessments: 'assessments',
  scorm_packages: 'scorm_packages',
  sessions: 'sessions',
  organizations: 'organizations',
  certificates: 'certificates',
} as const;

export type PublicIdTable = keyof typeof PUBLIC_ID_TABLES;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a URL parameter to the integer primary key it stands for.
 *
 * The product is moving its public URLs from sequential ids (/scorm-player/30)
 * to the opaque `public_id` UUID (migration 0046), WITHOUT changing the integer
 * primary keys the whole schema joins on. This is the one place that bridges the
 * two: a controller takes the param as a string and asks here for the id.
 *
 * It deliberately accepts EITHER form during the transition — an integer passes
 * straight through, a UUID is looked up — so every existing integer caller keeps
 * working the moment this ships and before the client has switched. Once the
 * client sends only UUIDs, the integer branch is dead code that harms nothing.
 *
 * Resolution is intentionally UNSCOPED: `public_id` is globally unique, and the
 * downstream service still applies its own org-scope and ownership checks, so a
 * guessed UUID that resolves to another tenant's row is refused there exactly as
 * a guessed integer id already is. Resolving here does not grant access.
 *
 * Global (provided by DatabaseModule) so any controller can inject it without a
 * module import, the same way DatabaseService is.
 */
@Injectable()
export class PublicIdService {
  constructor(private readonly database: DatabaseService) {}

  isUuid(value: string): boolean {
    return UUID_RE.test(value);
  }

  /** Integer id for the param, or null if it is neither a valid id nor a known UUID. */
  async resolveId(table: PublicIdTable, param: string): Promise<number | null> {
    if (/^\d+$/.test(param)) return Number(param);
    if (!this.isUuid(param)) return null;
    const tableName = PUBLIC_ID_TABLES[table]; // whitelisted literal, not caller input
    const rows = await this.database.db.all<{ id: number }>(
      sql`SELECT id FROM ${sql.identifier(tableName)} WHERE public_id = ${param} LIMIT 1`,
    );
    return rows[0]?.id ?? null;
  }

  /** As resolveId, but throws 404 when the param resolves to nothing. */
  async resolveIdOrThrow(table: PublicIdTable, param: string): Promise<number> {
    const id = await this.resolveId(table, param);
    if (id === null) throw new NotFoundException('Not found');
    return id;
  }
}
