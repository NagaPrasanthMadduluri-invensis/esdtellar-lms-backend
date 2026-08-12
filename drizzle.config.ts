import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit is used for INTROSPECTION and for generating SQL to review by
 * hand. Do not point `push` at the production Turso database: these tables hold
 * live data, and push resolves a schema drift by rewriting the table.
 *
 * The migrations that actually run are the hand-written, additive files in
 * `src/database/migrations/`, applied by DatabaseService on boot.
 */
export default defineConfig({
  dialect: 'turso',
  schema: './src/database/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.TURSO_DB_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  },
  verbose: true,
  strict: true,
});
