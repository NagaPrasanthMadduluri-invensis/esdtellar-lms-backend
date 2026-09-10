/**
 * Read-only health check for the tenancy + RBAC state of a database.
 * Spec: `specs/rbac.md` §3.2.1, §3.4, §3.7, §7.
 *
 *   node scripts/verify-rbac.mjs            (or: npm run db:verify:rbac)
 *
 * Written for the question "is production actually ready, and did the deploy
 * do what I think it did". It NEVER writes — no transaction, no --commit flag,
 * nothing to undo — so it is safe to run against production at any time,
 * including before the new code is deployed.
 *
 * Exits 0 when everything needed is in place, 1 when something needs a human.
 * Every failing check prints the exact next command, because the ordering
 * matters and getting it wrong is recoverable but confusing:
 *
 *     boot (0007 additive)  ->  db:migrate:tenancy --commit
 *     boot (0011 additive)  ->  db:migrate:rbac --commit
 *     boot (0014)           ->  grants the two permissions added later
 *
 * The checks are deliberately about STATE rather than about which scripts were
 * run: a database restored from a backup, or set up by hand, has no record of
 * the latter and the former is what the application actually depends on.
 */
import { readFileSync } from 'node:fs';

import pg from 'pg';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* env may be injected rather than filed */
}

/**
 * Mirrors PERMISSIONS in src/common/permissions.ts — 20 keys. Duplicated for
 * the same reason the other scripts duplicate it: this is a plain .mjs file
 * and that one is TypeScript compiled into dist/. Drift shows up here as a
 * false "unknown permission" report, which is the harmless direction.
 */
const CATALOGUE = [
  'view_dashboard',
  'view_employees',
  'edit_employees',
  'upload_content',
  'build_assessments',
  'assign_learning',
  'manage_users',
  'view_reports',
  'manage_courses',
  'manage_assessments',
  'view_certificates',
  'manage_certificates',
  'manage_sessions',
  'manage_roles',
  'view_team_learning',
  'view_own_sessions',
  'view_session_participants',
  'mark_attendance',
  'complete_session',
  'manage_session_roster',
];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Run this from the server/ directory.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

const q = async (sql, args = []) => (await pool.query(sql, args)).rows;
const one = async (sql, args = []) => (await q(sql, args))[0] ?? null;

let failures = 0;
let warnings = 0;

const pass = (label, detail = '') =>
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const fail = (label, detail, fix) => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  if (fix) console.log(`        fix: ${fix}`);
};
const warn = (label, detail, note) => {
  warnings += 1;
  console.log(`  WARN  ${label}${detail ? ` — ${detail}` : ''}`);
  if (note) console.log(`        ${note}`);
};

const tableExists = async (name) =>
  Boolean(
    await one(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [name],
    ),
  );

const columnIsNotNull = async (table, column) => {
  const row = await one(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return row ? row.is_nullable === 'NO' : null;
};

const constraintExists = async (name) =>
  Boolean(await one(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]));

try {
  const target = new URL(process.env.DATABASE_URL);
  const isLocal = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(target.hostname);

  console.log(`\nTarget: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log('Mode:   read-only');

  /**
   * Say which environment this is, unmissably.
   *
   * The point of this script is answering "is PRODUCTION ready", and it reads
   * `DATABASE_URL` from whatever `.env` sits next to it — so running it on a
   * laptop checks the laptop. That happened: a clean report was read as
   * "production is fine" when the target line said `127.0.0.1`. A quiet line
   * of provenance is not enough when the conclusion is the thing being acted
   * on, so the banner is loud and the closing summary repeats it.
   */
  console.log(
    isLocal
      ? '\n  >>> THIS IS A LOCAL DATABASE — it says nothing about production.\n' +
          '      To check production, run this ON the production host (it reads\n' +
          '      that host\'s server/.env), not on your laptop.\n'
      : `\n  Remote target — treating ${target.hostname} as the deployed database.\n`,
  );

  /* ── 1. Multi-tenancy ─────────────────────────────────────────────── */
  console.log('=== 1. Multi-tenancy (must be in place before RBAC) ===');

  if (!(await tableExists('organizations'))) {
    fail(
      'organizations table',
      'missing',
      'deploy the new code once so boot migration 0007 runs, then re-check',
    );
  } else {
    const orgs = await q(
      `SELECT id, name, slug, is_platform, is_active FROM organizations ORDER BY id`,
    );
    pass('organizations table', `${orgs.length} row(s)`);

    const platform = orgs.filter((o) => o.is_platform);
    if (platform.length === 1) {
      pass('platform organization', `id=${platform[0].id} slug=${platform[0].slug}`);
    } else if (platform.length === 0) {
      fail(
        'platform organization',
        'no organization has is_platform = true',
        'npm run db:migrate:tenancy -- --commit   (THE API WILL REFUSE TO BOOT WITHOUT THIS)',
      );
    } else {
      fail('platform organization', `${platform.length} of them — there must be exactly one`);
    }

    for (const o of orgs) {
      console.log(
        `        org ${String(o.id).padEnd(3)} ${o.slug.padEnd(24)} ` +
          `${o.is_platform ? 'PLATFORM' : 'tenant  '} ${o.is_active === 1 || o.is_active === true ? 'active' : 'INACTIVE'}`,
      );
    }

    const usersOrgNotNull = await columnIsNotNull('users', 'organization_id');
    if (usersOrgNotNull === true) pass('users.organization_id NOT NULL');
    else
      fail(
        'users.organization_id',
        'still nullable — the tenancy backfill has not been committed',
        'npm run db:migrate:tenancy -- --commit',
      );
  }

  /* ── 2. RBAC tables and constraints ───────────────────────────────── */
  console.log('\n=== 2. RBAC schema ===');

  const haveRoles = await tableExists('roles');
  const havePerms = await tableExists('role_permissions');
  if (haveRoles && havePerms) pass('roles + role_permissions tables');
  else
    fail(
      'roles / role_permissions',
      `roles=${haveRoles} role_permissions=${havePerms}`,
      'deploy the new code once so boot migration 0011 runs',
    );

  if (haveRoles) {
    const roleIdNotNull = await columnIsNotNull('users', 'role_id');
    if (roleIdNotNull === true) pass('users.role_id NOT NULL');
    else if (roleIdNotNull === false)
      fail(
        'users.role_id',
        'still nullable — the RBAC backfill has not been committed',
        'npm run db:migrate:rbac -- --commit',
      );
    else fail('users.role_id', 'column missing entirely', 'deploy so 0011 runs');

    if (await constraintExists('users_role_same_org'))
      pass('composite FK users_role_same_org', 'a cross-org role assignment is a DB error');
    else
      fail(
        'composite FK users_role_same_org',
        'missing',
        'npm run db:migrate:rbac -- --commit',
      );

    const pv = await columnIsNotNull('organizations', 'perm_version');
    const upv = await columnIsNotNull('users', 'perm_version');
    if (pv === true && upv === true)
      pass('perm_version on organizations and users', 'forced re-login can work');
    else
      fail(
        'perm_version columns',
        `organizations=${pv} users=${upv}`,
        'deploy the new code so boot migrations 0011 and 0013 run',
      );
  }

  /* ── 3. Every organization is usable ─────────────────────────────── */
  if (haveRoles && havePerms) {
    console.log('\n=== 3. Every organization is usable ===');

    const roleless = await q(`
      SELECT o.id, o.slug
        FROM organizations o
       WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.organization_id = o.id)
       ORDER BY o.id
    `);
    if (roleless.length === 0) pass('every organization has roles');
    else
      fail(
        'organizations with NO roles',
        roleless.map((r) => `${r.id}/${r.slug}`).join(', '),
        'npm run db:migrate:rbac -- --commit   (it seeds any organization that has none)',
      );

    const noAdmin = await q(`
      SELECT o.id, o.slug
        FROM organizations o
       WHERE NOT EXISTS (
         SELECT 1 FROM roles r
           JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'manage_roles'
          WHERE r.organization_id = o.id AND r.portal = 'admin'
       )
       ORDER BY o.id
    `);
    if (noAdmin.length === 0) pass('every organization has an administering role');
    else
      warn(
        'organizations with no admin-portal role holding manage_roles',
        noAdmin.map((r) => `${r.id}/${r.slug}`).join(', '),
        'nobody in those orgs can edit roles — a platform admin can fix it from the org page',
      );

    const nullRoleId = await q(
      `SELECT id, email FROM users WHERE role_id IS NULL ORDER BY id LIMIT 10`,
    );
    if (nullRoleId.length === 0) pass('every user has a role_id');
    else
      fail(
        'users with role_id NULL',
        `${nullRoleId.length}+ (${nullRoleId.map((u) => u.email).join(', ')})`,
        'npm run db:migrate:rbac -- --commit',
      );

    const mismatched = await q(`
      SELECT u.id, u.email, u.role, r.portal
        FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.role <> r.portal
       ORDER BY u.id LIMIT 10
    `);
    if (mismatched.length === 0) pass('users.role agrees with roles.portal everywhere');
    else
      fail(
        'users.role disagrees with its role portal',
        mismatched.map((u) => `${u.email} (${u.role} vs ${u.portal})`).join(', '),
        'reassign those users to their role via the admin UI — see specs/rbac.md §8.3',
      );
  }

  /* ── 4. Permission catalogue ─────────────────────────────────────── */
  if (havePerms) {
    console.log('\n=== 4. Permission catalogue ===');

    const missingNew = await q(
      `
      SELECT r.organization_id, o.slug, p.permission
        FROM roles r
        JOIN organizations o ON o.id = r.organization_id
       CROSS JOIN (SELECT unnest($1::text[]) AS permission) p
       WHERE r.key = 'admin' AND r.is_system = true
         AND NOT EXISTS (
           SELECT 1 FROM role_permissions rp
            WHERE rp.role_id = r.id AND rp.permission = p.permission
         )
       ORDER BY r.organization_id, p.permission
    `,
      [['manage_certificates', 'manage_sessions']],
    );
    if (missingNew.length === 0)
      pass('migration 0014 applied', 'admin roles hold manage_certificates + manage_sessions');
    else
      fail(
        'admin roles missing permissions added after their seeding',
        missingNew.map((r) => `${r.slug}:${r.permission}`).join(', '),
        'restart the API — boot migration 0014 grants them and forces a re-login',
      );

    const unknown = await q(
      `SELECT DISTINCT rp.permission FROM role_permissions rp
        WHERE NOT (rp.permission = ANY($1::text[])) ORDER BY 1`,
      [CATALOGUE],
    );
    if (unknown.length === 0) pass('no grants naming an unknown permission');
    else
      warn(
        'grants naming a permission this build does not have',
        unknown.map((r) => r.permission).join(', '),
        'harmless — no guard reads them, and they are filtered out of the token. ' +
          '`manage_departments` is expected here on any database seeded before 2026-09-09.',
      );

    const perOrg = await q(`
      SELECT o.slug, r.key, count(rp.permission) AS perms, count(DISTINCT u.id) AS holders
        FROM roles r
        JOIN organizations o ON o.id = r.organization_id
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN users u ON u.role_id = r.id AND u.is_active = 1
       GROUP BY o.slug, r.key, r.organization_id, r.id
       ORDER BY r.organization_id, r.key
    `);
    console.log('\n        org / role / permissions / active holders');
    for (const r of perOrg) {
      console.log(
        `        ${r.slug.padEnd(24)} ${r.key.padEnd(12)} ${String(r.perms).padStart(2)}  ${r.holders}`,
      );
    }
  }

  /* ── 5. Someone can actually log in ─────────────────────────────── */
  console.log('\n=== 5. Accounts ===');

  const platformAdmins = await q(`
    SELECT u.email, u.is_active
      FROM users u JOIN organizations o ON o.id = u.organization_id
     WHERE o.is_platform = true AND u.role = 'admin'
     ORDER BY u.id
  `);
  if (platformAdmins.length > 0) {
    pass(
      'platform administrator exists',
      platformAdmins.map((u) => `${u.email}${u.is_active ? '' : ' (INACTIVE)'}`).join(', '),
    );
  } else {
    fail(
      'platform administrator',
      'none — nobody can reach /platform/*',
      'npm run db:create-platform-admin -- --commit',
    );
  }

  const orgAdmins = await q(`
    SELECT o.slug, count(*) FILTER (WHERE u.is_active = 1) AS active
      FROM organizations o
      LEFT JOIN users u ON u.organization_id = o.id AND u.role = 'admin'
     WHERE o.is_platform = false
     GROUP BY o.slug ORDER BY o.slug
  `);
  for (const o of orgAdmins) {
    if (Number(o.active) > 0) pass(`org "${o.slug}" has an admin`, `${o.active} active`);
    else
      warn(
        `org "${o.slug}" has no active admin`,
        '',
        'a platform admin can create one from that organization\'s page',
      );
  }

  /* ── Summary ─────────────────────────────────────────────────────── */
  console.log('\n=== Summary ===');
  console.log(`  failures: ${failures}`);
  console.log(`  warnings: ${warnings}`);
  if (failures === 0) {
    console.log(
      `\n  Ready — for ${target.hostname}${isLocal ? ' (LOCAL, not production)' : ''}. ` +
        'Roles and permissions are enforced and every org is usable.',
    );
  } else {
    console.log('\n  Not ready — run the fixes above, in the order printed, then re-run this.');
  }
} catch (error) {
  console.error('\nverify-rbac failed:', error.message);
  failures += 1;
} finally {
  await pool.end();
}

process.exit(failures === 0 ? 0 : 1);
