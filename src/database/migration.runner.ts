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
    // Comments are stripped BEFORE splitting on `;`. Splitting first meant a
    // semicolon inside a comment cut the file mid-sentence, and the prose after
    // it — no longer starting with `--` — was handed to Postgres as a
    // statement. That failed the boot of the whole API, from a comma splice.
    const statements = stripComments(sql)
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);

    for (const statement of statements) {
      await pool.query(statement);
    }
    logger.log(`Applied migration ${file} (${statements.length} statements)`);
  }
}

/**
 * Strips SQL comments so a semicolon inside one cannot silently truncate a
 * statement mid-declaration.
 *
 * A whole-line check is not enough: an inline trailing comment
 * (`slug text UNIQUE, -- URL-safe; subdomains later`) that itself contains a
 * semicolon slices the surrounding `CREATE TABLE` in two, and the tail is
 * handed to Postgres as its own "statement" next — exactly what took down
 * `0007_organizations.sql` on boot before this fix. Corrected by scanning
 * character-by-character and tracking quoting state, rather than trusting
 * `--` to only ever appear at the start of a line.
 *
 * Tracks, so none of these can be mistaken for a comment or have their own
 * `;` / `--` mistaken for statement structure:
 * - single-quoted string literals ('...', with '' as an escaped quote)
 * - double-quoted identifiers ("...", with "" as an escaped quote)
 * - dollar-quoted bodies ($$...$$ or $tag$...$tag$) — no migration here has
 *   one yet, but a future function body must not be corrupted by this parser
 *
 * C-style block comments are intentionally not handled — none of these
 * hand-written, additive migrations use one, and this function is
 * deliberately proportionate to that, not a general SQL parser.
 */
function stripComments(sql: string): string {
  let result = '';
  let i = 0;
  const n = sql.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarTag: string | null = null;

  while (i < n) {
    const ch = sql[i];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        result += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        result += ch;
        i += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      result += ch;
      if (ch === "'" && sql[i + 1] === "'") {
        result += sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === "'") inSingleQuote = false;
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      result += ch;
      if (ch === '"' && sql[i + 1] === '"') {
        result += sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      result += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      result += ch;
      i += 1;
      continue;
    }

    if (ch === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        result += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === '-' && sql[i + 1] === '-') {
      const newlineIndex = sql.indexOf('\n', i);
      if (newlineIndex === -1) break; // comment runs to end of file
      i = newlineIndex;
      continue;
    }

    result += ch;
    i += 1;
  }

  return result;
}
