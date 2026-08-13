import { Pool } from 'pg';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from './schema';
import { runMigrations } from './migration.runner';

export type Database = NodePgDatabase<typeof schema>;

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
        ? { rejectUnauthorized: false }
        : undefined,
    });
    this.db = drizzle(this.pool, { schema });
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
