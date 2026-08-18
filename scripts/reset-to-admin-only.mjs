/**
 * DESTRUCTIVE: empties the database, keeping only admin accounts.
 *
 * For handing a clean application to an admin who will onboard learners,
 * upload courses and assign them from scratch.
 *
 * Deliberately NOT in database/migrations/ — those run on every boot, and a
 * wipe that re-ran on each restart would delete the admin's real work. This is
 * the "human checkpoint" case in BACKEND_STRUCTURE.md §6.2: read it, run it
 * once, deliberately.
 *
 * WHAT SURVIVES: rows in `users` with role = 'admin'. Nothing else.
 * WHAT DOES NOT: every learner, course, module, lesson, assessment, attempt,
 * session, SCORM package, certificate and progress record.
 *
 * Identity sequences are reset for every table EXCEPT users, so the first
 * course created afterwards is id 1. `users` cannot be truncated without
 * taking the admin with it, so learner ids continue from where they left off
 * — cosmetic, but do not expect the first new learner to be id 2.
 *
 *   node scripts/reset-to-admin-only.mjs            (dry run — shows counts)
 *   node scripts/reset-to-admin-only.mjs --commit   (applies it)
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* env may be injected rather than filed */ }

const commit = process.argv.includes('--commit');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  // Every table the app owns, discovered rather than hard-coded, so a table
  // added later is not silently left full of stale rows.
  const { rows: tables } = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' ORDER BY tablename
  `);
  const names = tables.map((t) => t.tablename);

  console.log('Current contents:\n');
  let total = 0;
  for (const name of names) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM "${name}"`);
    total += rows[0].c;
    console.log(`  ${String(rows[0].c).padStart(6)}  ${name}`);
  }

  const { rows: admins } = await pool.query(
    `SELECT id, email FROM users WHERE role = 'admin' ORDER BY id`,
  );
  console.log(`\n${admins.length} admin account(s) will be KEPT:`);
  for (const a of admins) console.log(`  [${a.id}] ${a.email}`);

  if (admins.length === 0) {
    console.error(
      '\nREFUSING: there is no admin account to keep. Wiping now would lock ' +
        'everyone out of the application. Create an admin first.',
    );
    process.exitCode = 1;
  } else if (!commit) {
    console.log(`\nDRY RUN — ${total} row(s) across ${names.length} tables would be removed.`);
    console.log('Re-run with --commit to apply.');
  } else {
    // Truncate everything except users, then drop non-admin users. CASCADE
    // handles the foreign keys; RESTART IDENTITY makes ids start from 1 again.
    const wipe = names.filter((n) => n !== 'users');
    await pool.query('BEGIN');
    if (wipe.length > 0) {
      await pool.query(
        `TRUNCATE ${wipe.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
    }
    const del = await pool.query(`DELETE FROM users WHERE role <> 'admin'`);
    await pool.query('COMMIT');

    console.log(`\nWiped ${wipe.length} tables and ${del.rowCount} non-admin user(s).`);
    console.log('Admin accounts and their passwords are unchanged.');
    console.log(
      '\nStill on disk / in object storage — remove separately if you want them gone:\n' +
        '  server/storage/scorm/*   extracted SCORM packages\n' +
        '  R2 bucket lessons/*      uploaded videos and captions',
    );
  }
} finally {
  await pool.end();
}
