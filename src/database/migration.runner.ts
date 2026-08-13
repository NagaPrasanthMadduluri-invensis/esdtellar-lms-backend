import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pool } from 'pg';
import type { Logger } from '@nestjs/common';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Applies every `.sql` file in `database/migrations/` in filename order.
 *
 * Deliberately NOT drizzle-kit push: push diffs the live database against the
 * Drizzle schema and will happily drop or rewrite a table when the two disagree
 * on something cosmetic. Migrations here are hand-written, additive, and
 * idempotent (`IF NOT EXISTS`), which makes re-running them on every boot a
 * no-op.
 *
 * Use `npm run db:push` only against a scratch database.
 */
export async function runMigrations(
  pool: Pool,
  logger: Logger,
): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith('.sql'))
      .sort();
  } catch {
    logger.warn(`No migrations directory at ${MIGRATIONS_DIR} — skipping.`);
    return;
  }

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const statements = sql
      .split(';')
      .map((statement) => stripComments(statement).trim())
      .filter((statement) => statement.length > 0);

    for (const statement of statements) {
      await pool.query(statement);
    }
    logger.log(`Applied migration ${file} (${statements.length} statements)`);
  }
}

function stripComments(statement: string): string {
  return statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}
