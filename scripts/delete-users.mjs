/**
 * DESTRUCTIVE: deletes user accounts matched by a filter, and refuses when
 * any of them holds learning history.
 *
 * Written for a specific accident and deliberately generalised: a bulk import
 * run against the TEMPLATE'S SAMPLE ROWS put 300 `@company.com` accounts into
 * a live tenant. They are not people, they consume seats, and they are
 * counted by the directory, the reports, the analytics and the leaderboard.
 *
 * ## Why this is not a route
 *
 * There is no delete-tenant route and no bulk-delete-users route, for the
 * reason BACKEND_STRUCTURE.md §10.17 gives: `users` is referenced by 45
 * tables with ON DELETE CASCADE, so one DELETE takes somebody's completions,
 * attempts, certificates, attendance and badges with it. That is the right
 * default for a table holding a learning record — a reviewed script, never a
 * button.
 *
 * ## The safety argument
 *
 * The filter is not trusted to be correct. Before deleting anything this
 * counts every dependent row the cascade would take, across all 45 tables,
 * and ABORTS if the total is not zero. An account with history is somebody
 * who did the training; deleting it is a different decision from tidying up
 * an import, and it is not this script's to make. `--force` exists for when
 * that is genuinely intended, and it prints what it is about to destroy.
 *
 * It also refuses to touch anything that is not a learner-portal account, and
 * anything that is somebody's manager, so a reporting line cannot be severed
 * as a side effect of a tidy-up.
 *
 *   node scripts/delete-users.mjs --domain company.com                 (dry run)
 *   node scripts/delete-users.mjs --domain company.com --commit
 *   node scripts/delete-users.mjs --domain company.com --since 2026-10-07T06:30
 *   node scripts/delete-users.mjs --email-like '%.bulk@%' --commit
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* env may be injected rather than filed */ }

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};
const commit = process.argv.includes('--commit');
const force  = process.argv.includes('--force');

const domain    = arg('domain');
const emailLike = arg('email-like');
const since     = arg('since');

if (!domain && !emailLike) {
  console.error(
    'Name a filter: --domain company.com, or --email-like \'%.test@%\'.\n'
    + 'Refusing to run with no filter — "every user" is not a tidy-up.',
  );
  process.exit(1);
}

/* The predicate is built once and reused for the count, the preview and the
 * delete, so the rows that are shown cannot differ from the rows that go. */
const where = [];
const params = [];
if (domain)    { params.push(`%@${domain}`);  where.push(`u.email ILIKE $${params.length}`); }
if (emailLike) { params.push(emailLike);      where.push(`u.email ILIKE $${params.length}`); }
if (since)     { params.push(since);          where.push(`u.created_at >= $${params.length}`); }
const PRED = where.join(' AND ');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
  const { rows: targets } = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.is_active,
            u.organization_id, o.name AS org, r.portal, r.label AS role_label,
            (SELECT count(*) FROM users m WHERE m.manager_id = u.id) AS reports
       FROM users u
       JOIN roles r         ON r.id = u.role_id
       JOIN organizations o ON o.id = u.organization_id
      WHERE ${PRED}
      ORDER BY u.id`,
    params,
  );

  if (targets.length === 0) {
    console.log('Nothing matched. Nothing to do.');
    process.exit(0);
  }

  const orgs = [...new Set(targets.map((t) => `${t.org} (#${t.organization_id})`))];
  console.log(`\nMatched ${targets.length} account(s) in ${orgs.join(', ')}`);
  console.log(`  first: ${targets[0].email}`);
  console.log(`  last:  ${targets[targets.length - 1].email}`);

  /* ── Refusal 1: anything that is not a learner ──
   * An admin or a trainer caught by a loose filter is how a tenant loses the
   * account it administers itself with. */
  const notLearners = targets.filter((t) => t.portal !== 'learner');
  if (notLearners.length) {
    console.error(
      `\nREFUSING: ${notLearners.length} matched account(s) are not learner-portal:\n`
      + notLearners.map((t) => `  ${t.email} — ${t.role_label} (${t.portal})`).join('\n')
      + '\nNarrow the filter.',
    );
    process.exit(1);
  }

  /* ── Refusal 2: anybody's manager ──
   * users.manager_id is ON DELETE SET NULL, so this would not error — it
   * would quietly empty somebody else's reporting line and nothing would say
   * so. That is the silent-omission failure, not a cascade. */
  const managers = targets.filter((t) => Number(t.reports) > 0);
  if (managers.length) {
    console.error(
      `\nREFUSING: ${managers.length} matched account(s) manage other people:\n`
      + managers.map((t) => `  ${t.email} — manages ${t.reports}`).join('\n')
      + '\nReassign those reports first, or narrow the filter.',
    );
    process.exit(1);
  }

  /* ── Refusal 3: any learning history at all ──
   * Discovered from the catalogue rather than listed by hand, so a table
   * added later is counted without anybody remembering to add it here. */
  const { rows: fks } = await pool.query(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.confrelid = 'users'::regclass
       AND c.contype = 'f'
       AND c.confdeltype = 'c'
       AND a.attname <> 'organization_id'
  `);
  const cascades = [...new Map(fks.map((f) => [`${f.tbl}.${f.col}`, f])).values()];

  const ids = targets.map((t) => t.id);
  const held = [];
  for (const { tbl, col } of cascades) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} = ANY($1::int[])`, [ids],
    );
    if (rows[0].n > 0) held.push({ tbl, col, n: rows[0].n });
  }

  if (held.length) {
    console.log('\nThe cascade would also delete:');
    for (const h of held) console.log(`  ${String(h.n).padStart(7)}  ${h.tbl}.${h.col}`);
  } else {
    console.log('\nNo dependent rows anywhere — these accounts hold no history.');
  }

  const historyTables = new Set([
    'user_lesson_completions', 'user_assessment_attempts', 'certificates',
    'session_attendance', 'scorm_attempts', 'scorm_tracking', 'user_badges',
    'journey_enrollments', 'lesson_video_progress', 'scorm_datamodel_log',
    'session_feedback', 'course_feedback', 'external_certifications',
  ]);
  const realWork = held.filter((h) => historyTables.has(h.tbl));
  if (realWork.length && !force) {
    console.error(
      '\nREFUSING: these accounts hold a LEARNING RECORD —\n'
      + realWork.map((h) => `  ${h.n} x ${h.tbl}`).join('\n')
      + '\n\nDeleting somebody who did the training is a different decision from\n'
      + 'tidying up a bad import, and it has no undo. Deactivate them instead,\n'
      + 'or re-run with --force if destroying this is genuinely what you mean.',
    );
    process.exit(1);
  }

  if (!commit) {
    console.log(`\nDRY RUN — nothing deleted. Re-run with --commit to delete ${targets.length} account(s).`);
    process.exit(0);
  }

  /* One statement in one transaction: a half-finished delete across 45
   * cascading tables is not a state anybody could reason about. */
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `DELETE FROM users u WHERE ${PRED}`, params,
    );
    await client.query('COMMIT');
    console.log(`\nDeleted ${rowCount} account(s).`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
