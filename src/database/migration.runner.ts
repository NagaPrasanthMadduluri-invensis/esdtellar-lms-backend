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
    // Comments are stripped AND statements are split in the same character
    // scan (see `splitStatements`). Splitting on a naive `sql.split(';')` —
    // even after stripping comments — tears apart any statement that legally
    // contains its own `;`, such as a `DO $$ ... END $$;` block: everything
    // up to the block's first internal `;` becomes a "statement" on its own
    // and Postgres rejects it as unterminated. Splitting has to share the
    // same quote/dollar-quote state the comment stripper tracks, or it would
    // just as happily cut a semicolon out of a string literal.
    const statements = splitStatements(sql);

    for (const statement of statements) {
      await pool.query(statement);
    }
    logger.log(`Applied migration ${file} (${statements.length} statements)`);
  }
}

/**
 * Strips SQL comments and splits the remainder into individual statements on
 * `;`, in a single character-by-character scan.
 *
 * A whole-line check is not enough for comments: an inline trailing comment
 * (`slug text UNIQUE, -- URL-safe; subdomains later`) that itself contains a
 * semicolon slices the surrounding `CREATE TABLE` in two, and the tail is
 * handed to Postgres as its own "statement" next — exactly what took down
 * `0007_organizations.sql` on boot before this fix. And a naive `.split(';')`
 * is not enough for statement splitting: it tears apart anything containing a
 * legal internal `;`, such as a `DO $$ ... END $$;` block used to guard a
 * conditionally-existing column. Both are corrected by scanning
 * character-by-character and tracking quoting state, rather than trusting
 * `--` to only ever appear at the start of a line or `;` to only ever appear
 * at the end of a statement.
 *
 * Tracks, so none of these can be mistaken for a comment or have their own
 * `;` / `--` mistaken for statement structure:
 * - single-quoted string literals ('...', with '' as an escaped quote)
 * - double-quoted identifiers ("...", with "" as an escaped quote)
 * - dollar-quoted bodies ($$...$$ or $tag$...$tag$) — including the `DO`
 *   block bodies introduced for the conditional org-column logic
 *
 * C-style block comments are intentionally not handled — none of these
 * hand-written, additive migrations use one, and this function is
 * deliberately proportionate to that, not a general SQL parser.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let dollarTag: string | null = null;

  while (i < n) {
    const ch = sql[i];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += ch;
        i += 1;
      }
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && sql[i + 1] === "'") {
        current += sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === "'") inSingleQuote = false;
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"' && sql[i + 1] === '"') {
        current += sql[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
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

    if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current.trim().length > 0) statements.push(current);

  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
