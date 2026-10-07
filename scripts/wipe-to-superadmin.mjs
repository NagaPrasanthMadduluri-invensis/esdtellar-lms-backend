/**
 * DESTRUCTIVE: empties the database down to the platform and its superadmin.
 *
 * For starting production clean: the superadmin then onboards each
 * organization, whose admin onboards their own learners.
 *
 * WHAT SURVIVES
 *   - the platform organization (organizations.is_platform)
 *   - its roles and their permissions
 *   - its ADMIN accounts — the superadmin(s) — with their passwords unchanged
 *   - the platform org's own option and template rows, which are harmless
 *
 * WHAT DOES NOT: every other organization, every other user, and every row of
 * learning, content, sessions, certificates, notifications, email, billing,
 * audit and activity data — for every organization, the platform included.
 *
 * WHY NOT reset-to-admin-only.mjs: that script truncates every table except
 * users and organizations, which includes `roles`. users.role_id references
 * roles, so TRUNCATE roles CASCADE also truncates `users` — every account,
 * the superadmin included, and nobody can sign in afterwards. It also keeps
 * every tenant's admins, which is not what a clean start means.
 *
 * THE CASCADE GUARD: TRUNCATE ... CASCADE empties every table holding a
 * foreign key INTO a truncated table. So before writing anything this script
 * asks the live catalogue whether any KEPT table references a TRUNCATED one,
 * and refuses if so — a schema change cannot silently turn this into a wipe
 * of the accounts it exists to keep.
 *
 *   node scripts/wipe-to-superadmin.mjs            dry run: counts and the kept accounts
 *   node scripts/wipe-to-superadmin.mjs --commit   applies it, in one transaction
 *
 * NOT TOUCHED: files outside the database (uploaded SCORM packages, videos,
 * documents, thumbnails, logos) and the pg-boss schema.
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

/** Tables whose rows are FILTERED, never truncated. Everything else is emptied. */
const KEEP = new Set([
  'organizations',
  'users',
  'roles',
  'role_permissions',
  'feedback_templates',
  'feedback_template_questions',
  'organization_locations',
  'organization_job_levels',
]);

try {
  const { rows: platform } = await pool.query(
    `SELECT id, name FROM organizations WHERE is_platform ORDER BY id`,
  );
  if (platform.length === 0) {
    console.error('REFUSING: there is no platform organization. The API cannot boot without one.');
    process.exit(1);
  }
  const platformIds = platform.map((o) => o.id);

  const { rows: keepUsers } = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.last_name
       FROM users u
      WHERE u.organization_id = ANY($1::int[]) AND u.role = 'admin' AND u.is_active = 1
      ORDER BY u.id`,
    [platformIds],
  );
  if (keepUsers.length === 0) {
    console.error(
      'REFUSING: the platform organization has no active admin. After the wipe ' +
        'nobody could sign in to onboard an organization.',
    );
    process.exit(1);
  }

  const { rows: tables } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const all = tables.map((t) => t.tablename);
  const truncate = all.filter((t) => !KEEP.has(t));

  // The cascade guard — see the header.
  const { rows: risky } = await pool.query(
    `SELECT DISTINCT src.relname AS kept, dst.relname AS truncated
       FROM pg_constraint c
       JOIN pg_class src ON src.oid = c.conrelid
       JOIN pg_class dst ON dst.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
        AND src.relname = ANY($1::text[]) AND dst.relname = ANY($2::text[])`,
    [[...KEEP], truncate],
  );
  if (risky.length > 0) {
    console.error('REFUSING: a kept table references a table that would be truncated,');
    console.error('so TRUNCATE CASCADE would empty the kept table too:');
    for (const r of risky) console.error(`  ${r.kept} -> ${r.truncated}`);
    process.exit(1);
  }

  console.log('Current contents:\n');
  let total = 0;
  for (const name of all) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM "${name}"`);
    total += rows[0].c;
    console.log(`  ${String(rows[0].c).padStart(7)}  ${name}${KEEP.has(name) ? '   (filtered)' : ''}`);
  }

  const { rows: [counts] } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM organizations WHERE NOT is_platform) AS orgs,
       (SELECT COUNT(*)::int FROM users WHERE NOT (id = ANY($1::int[]))) AS users`,
    [keepUsers.map((u) => u.id)],
  );

  console.log(`\nPlatform organization kept: ${platform.map((o) => `[${o.id}] ${o.name}`).join(', ')}`);
  console.log(`Superadmin account(s) kept (${keepUsers.length}):`);
  for (const u of keepUsers) console.log(`  [${u.id}] ${u.email}  ${u.first_name ?? ''} ${u.last_name ?? ''}`);
  console.log(`\nWould remove: ${counts.orgs} organization(s), ${counts.users} user(s), and empty ${truncate.length} table(s).`);

  if (!commit) {
    console.log('\nDRY RUN — nothing changed. Re-run with --commit to apply.');
  } else {
    const keepIds = keepUsers.map((u) => u.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `TRUNCATE ${truncate.map((n) => `"${n}"`).join(', ')} RESTART IDENTITY CASCADE`,
      );
      // Users before organizations: users.organization_id is NO ACTION.
      const delUsers = await client.query(
        `DELETE FROM users WHERE NOT (id = ANY($1::int[]))`,
        [keepIds],
      );
      // Cascades each tenant's roles (and so role_permissions), feedback
      // templates and their questions, locations and job levels.
      const delOrgs = await client.query(`DELETE FROM organizations WHERE NOT is_platform`);

      // Proof inside the transaction, before COMMIT: the superadmins are
      // still here and nothing else is.
      const { rows: [after] } = await client.query(
        `SELECT (SELECT COUNT(*)::int FROM users) AS users,
                (SELECT COUNT(*)::int FROM users WHERE id = ANY($1::int[])) AS kept,
                (SELECT COUNT(*)::int FROM organizations) AS orgs,
                (SELECT COUNT(*)::int FROM roles r JOIN users u ON u.role_id = r.id
                  WHERE u.id = ANY($1::int[])) AS kept_with_role`,
        [keepIds],
      );
      if (after.kept !== keepIds.length || after.users !== keepIds.length || after.kept_with_role !== keepIds.length) {
        throw new Error(`post-check failed: ${JSON.stringify(after)} — rolled back`);
      }
      await client.query('COMMIT');
      console.log(
        `\nDone. Removed ${delOrgs.rowCount} organization(s) and ${delUsers.rowCount} user(s); ` +
          `emptied ${truncate.length} table(s).`,
      );
      console.log(`Left: ${after.orgs} organization(s), ${after.users} user(s) — the superadmin(s), roles intact.`);
      console.log(
        '\nNot touched — remove separately if wanted: uploaded files (SCORM packages,\n' +
          'videos, documents, thumbnails, logos) and the pg-boss schema.',
      );
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`\nROLLED BACK — nothing changed: ${error.message}`);
      process.exitCode = 1;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
