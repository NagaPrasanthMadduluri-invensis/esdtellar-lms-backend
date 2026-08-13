import { Pool, types } from 'pg';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';

import * as schema from './schema';
import { runMigrations } from './migration.runner';

// pg returns bigint (COUNT(*)) and numeric (AVG, ROUND(...)) as strings by
// default, to avoid precision loss outside Number.MAX_SAFE_INTEGER. Every
// aggregate in this codebase is a row count or a duration sum — safely within
// that range — and every consumer expects a JS number, matching the original
// libsql behavior. This is a global registration on the `pg` module, so it
// must run once before any query executes; module load time is early enough.
types.setTypeParser(20, Number); // int8 / bigint
types.setTypeParser(1700, Number); // numeric

/**
 * `NodePgDatabase` has no `.all()`/`.run()` — those are SQLite-only terminal
 * methods for raw `sql` templates. 8 repository files use them for
 * hand-written aggregate queries (`this.db.all(sql\`...\`)`,
 * `this.db.run(sql\`...\`)`), relying on Drizzle's SQLite query-builder shape.
 * Rather than rewrite ~70 call sites (and their `.all<SomeRowType>(...)`
 * generic type arguments) across those files, this thin compatibility layer
 * keeps every existing call site working unchanged: `.all()` delegates to
 * `.execute()` and returns `.rows`; `.run()` delegates to `.execute()` and
 * discards the result.
 */
export type Database = NodePgDatabase<typeof schema> & {
  all<T = unknown>(query: SQL): Promise<T[]>;
  run(query: SQL): Promise<void>;
};

function withSqliteCompat(db: NodePgDatabase<typeof schema>): Database {
  return Object.assign(db, {
    async all<T = unknown>(query: SQL): Promise<T[]> {
      const result = await db.execute(query);
      return result.rows as T[];
    },
    async run(query: SQL): Promise<void> {
      await db.execute(query);
    },
  });
}

/**
 * Owns the single Postgres connection pool for the process.
 *
 * This replaces the legacy `globalThis._lmsDb` cache, which existed only to
 * survive Next.js hot-reloads and had the side effect that schema changes were
 * invisible until the dev server was killed. Nest's DI container gives us a
 * true singleton with a real lifecycle instead.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  /** Drizzle handle. Inject DatabaseService and use `.db` for all queries. */
  readonly db: Database;

  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      connectionString: this.config.getOrThrow<string>('database.url'),
      ssl: this.config.get<boolean>('database.ssl')
        ? { rejectUnauthorized: this.config.get<boolean>('database.sslRejectUnauthorized') }
        : undefined,
      options: '-c TimeZone=UTC',
    });
    this.db = withSqliteCompat(drizzle(this.pool, { schema }));
  }

  async onModuleInit(): Promise<void> {
    // Additive-only: CREATE INDEX IF NOT EXISTS. Never creates or alters a
    // table beyond CREATE TABLE IF NOT EXISTS on a fresh database.
    await runMigrations(this.pool, this.logger);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
