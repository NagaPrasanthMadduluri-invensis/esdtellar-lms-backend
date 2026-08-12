import { createClient, type Client } from '@libsql/client';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';

import * as schema from './schema';
import { runMigrations } from './migration.runner';

export type Database = LibSQLDatabase<typeof schema>;

/**
 * Owns the single libsql connection for the process.
 *
 * This replaces the legacy `globalThis._lmsDb` cache, which existed only to
 * survive Next.js hot-reloads and had the side effect that schema changes were
 * invisible until the dev server was killed. Nest's DI container gives us a
 * true singleton with a real lifecycle instead.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly client: Client;

  /** Drizzle handle. Inject DatabaseService and use `.db` for all queries. */
  readonly db: Database;

  constructor(private readonly config: ConfigService) {
    this.client = createClient({
      url: this.config.getOrThrow<string>('database.url'),
      authToken: this.config.getOrThrow<string>('database.authToken'),
    });
    this.db = drizzle(this.client, { schema });
  }

  async onModuleInit(): Promise<void> {
    // Additive-only: CREATE INDEX IF NOT EXISTS. Never creates or alters a
    // table — the 18 tables already exist in Turso with production data.
    await runMigrations(this.client, this.logger);
  }

  onModuleDestroy(): void {
    this.client.close();
  }
}
