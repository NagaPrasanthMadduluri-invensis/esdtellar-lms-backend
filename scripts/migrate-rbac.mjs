/**
 * RBAC, phase 2 of 2 — the DELIBERATE half. Spec: `specs/rbac.md` §3.3–§3.7, §7.1.
 *
 * `0011_rbac_roles.sql` (additive, runs automatically on boot) already created
 * `roles`, `role_permissions`, a NULLABLE `users.role_id` and
 * `organizations.perm_version`. This script does everything that migration
 * deliberately left out because it is neither additive nor safe to re-run on
 * every boot (BACKEND_STRUCTURE.md §6.2):
 *
 *   1. Seed each organization's three system roles, with their permissions.
 *   2. Backfill users.role_id from the users.role each user already has.
 *   3. Add the composite FK (organization_id, role_id) -> roles, so a
 *      cross-organization role assignment is rejected by POSTGRES.
 *   4. SET NOT NULL on users.role_id.
 *   5. Verify: no NULLs, no cross-org assignments, portal agrees with
 *      users.role, row counts unchanged. Abort on any mismatch.
 *
 * Every organization is seeded, including the platform organization — its
 * admins are ordinary `users` rows (multi-tenancy.md §4.2), so they need a
 * role like everyone else or step 4 could not succeed.
 *
 * The whole thing is ONE transaction. In dry-run mode (the default) every
 * statement still runs — seeds, backfill, constraint, SET NOT NULL and the
 * verification pass — so a dry run genuinely exercises the migration; it just
 * ROLLBACKs at the end instead of committing. The one cosmetic side effect a
 * rollback cannot undo is `roles_id_seq` advancing past the ids a dry run
 * allocated and then discarded.
 *
 *   node scripts/migrate-rbac.mjs            (dry run — shows what would happen)
 *   node scripts/migrate-rbac.mjs --commit   (applies it)
 *
 * This does NOT bump perm_version. The column defaults to 1 and no token in
 * existence carries a permissions claim yet, so there is nothing to invalidate;
 * the forced-re-login behaviour starts mattering when the guard ships.
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

const commit = process.argv.includes('--commit');

/**
 * Mirrors SYSTEM_ROLES in src/common/permissions.ts. Duplicated because this
 * is a plain .mjs script and that file is TypeScript compiled to dist/ — the
 * same reason scripts/seed.mjs re-implements hashPassword. Keep the two in
 * step; the verification in step 5 fails loudly if a portal here disagrees
 * with the users.role it is mapped from.
 */
const ALL_PERMISSIONS = [
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
  'manage_departments',
  'view_certificates',
  'manage_roles',
  'view_team_learning',
  'view_own_sessions',
  'view_session_participants',
  'mark_attendance',
  'complete_session',
  'manage_session_roster',
];

const SYSTEM_ROLES = [
  { key: 'admin', label: 'Admin', portal: 'admin', scope: 'org', permissions: ALL_PERMISSIONS },
  {
    key: 'manager',
    label: 'Manager',
    portal: 'learner',
    scope: 'department',
    permissions: ['view_dashboard', 'view_reports', 'view_team_learning'],
  },
  { key: 'learner', label: 'Learner', portal: 'learner', scope: 'self', permissions: [] },
];

/** users.role -> the seeded role key it backfills onto. */
const ROLE_TO_KEY = { admin: 'admin', learner: 'learner' };

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const client = await pool.connect();
  try {
    const target = new URL(process.env.DATABASE_URL);
    console.log(`\nTarget: ${target.hostname}:${target.port || 5432}/${target.pathname.slice(1)}`);
    console.log(commit ? 'Mode:   COMMIT\n' : 'Mode:   dry run (rolls back at the end)\n');

    /* ── preflight: phase 1 must have run ──────────────────────────────── */
    const { rows: cols } = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'users'         AND column_name = 'role_id')
            OR (table_name = 'organizations' AND column_name = 'perm_version'))`,
    );
    const { rows: tbls } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [['roles', 'role_permissions']],
    );
    const missing = [];
    if (!cols.some((c) => c.table_name === 'users')) missing.push('users.role_id');
    if (!cols.some((c) => c.table_name === 'organizations')) missing.push('organizations.perm_version');
    for (const t of ['roles', 'role_permissions']) {
      if (!tbls.some((r) => r.table_name === t)) missing.push(`table ${t}`);
    }
    if (missing.length > 0) {
      console.error(
        `REFUSING: phase 1 is incomplete — missing ${missing.join(', ')}. ` +
          'Start the API once so 0011_rbac_roles.sql is applied, then re-run.',
      );
      process.exitCode = 1;
      return;
    }

    /* ── refuse to run twice ───────────────────────────────────────────── */
    const { rows: existing } = await client.query('SELECT COUNT(*)::int AS c FROM roles');
    if (existing[0].c > 0) {
      console.log(
        `REFUSING to run again: ${existing[0].c} role(s) already exist, so this ` +
          'migration has already been applied. No changes made.\n' +
          'Roles are edited through the admin UI from here on, not by re-running this.',
      );
      process.exitCode = 0;
      return;
    }

    const { rows: orgs } = await client.query(
      'SELECT id, name, slug, is_platform FROM organizations ORDER BY id',
    );
    if (orgs.length === 0) {
      console.error(
        'REFUSING: no organizations exist. Run scripts/migrate-tenancy.mjs --commit first.',
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Organizations to seed roles for: ${orgs.length}`);
    for (const o of orgs) {
      console.log(`  [${o.id}] ${o.name} (${o.slug})${o.is_platform ? ' — platform' : ''}`);
    }

    /* ── one transaction from here ─────────────────────────────────────── */
    await client.query('BEGIN');

    const { rows: usersBefore } = await client.query('SELECT COUNT(*)::int AS c FROM users');
    const before = usersBefore[0].c;
    console.log(`\nUsers before: ${before}`);

    /* ── 1. seed system roles, one statement per org per role ──────────── */
    console.log('\n1. Seeding system roles');
    let rolesCreated = 0;
    let grantsCreated = 0;
    for (const org of orgs) {
      for (const role of SYSTEM_ROLES) {
        const { rows } = await client.query(
          `INSERT INTO roles (organization_id, key, label, portal, scope, is_system)
           VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
          [org.id, role.key, role.label, role.portal, role.scope],
        );
        const roleId = rows[0].id;
        rolesCreated += 1;
        if (role.permissions.length > 0) {
          // One multi-row INSERT, not one per permission (§7.1).
          const { rowCount } = await client.query(
            `INSERT INTO role_permissions (role_id, permission)
             SELECT $1, p FROM unnest($2::text[]) AS p`,
            [roleId, role.permissions],
          );
          grantsCreated += rowCount;
        }
      }
      console.log(`  [${org.id}] ${org.slug}: ${SYSTEM_ROLES.length} roles`);
    }
    console.log(`  ${rolesCreated} roles, ${grantsCreated} permission grants`);

    /* ── 2. backfill users.role_id — set-based, no loops ───────────────── */
    console.log('\n2. Backfilling users.role_id from users.role');
    for (const [userRole, roleKey] of Object.entries(ROLE_TO_KEY)) {
      const { rowCount } = await client.query(
        `UPDATE users u
            SET role_id = r.id
           FROM roles r
          WHERE r.organization_id = u.organization_id
            AND r.key = $1
            AND u.role = $2
            AND u.role_id IS NULL`,
        [roleKey, userRole],
      );
      console.log(`  role='${userRole}' -> roles.key='${roleKey}': ${rowCount} user(s)`);
    }

    /* ── 3. composite FKs: the structural guarantee ────────────────────── */
    console.log('\n3. Adding the composite FK users (organization_id, role_id) -> roles');
    await client.query(
      `ALTER TABLE users
         ADD CONSTRAINT users_role_same_org
         FOREIGN KEY (organization_id, role_id) REFERENCES roles (organization_id, id)`,
    );
    console.log('  users_role_same_org added');

    /* ── 3b. sessions.trainer_user_id -> users, same-org ───────────────── */
    // The trainer portal's whole scope is "sessions where trainer_user_id is
    // me", so the column gets the same composite-FK treatment as every other
    // link here: a session pointing at a user in ANOTHER organization is
    // rejected by Postgres. It stays nullable — an unassigned session is
    // legitimate, it simply appears in no trainer's portal.
    console.log('\n3b. Adding the composite FK sessions (organization_id, trainer_user_id) -> users');
    const { rows: trainerCol } = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sessions'
          AND column_name = 'trainer_user_id'`,
    );
    if (trainerCol.length === 0) {
      throw new Error(
        'sessions.trainer_user_id is missing — start the API once so ' +
          '0012_trainer_portal.sql is applied, then re-run.',
      );
    }
    await client.query(
      `ALTER TABLE sessions
         ADD CONSTRAINT sessions_trainer_same_org
         FOREIGN KEY (organization_id, trainer_user_id) REFERENCES users (organization_id, id)`,
    );
    console.log('  sessions_trainer_same_org added');

    /* ── 4. SET NOT NULL ──────────────────────────────────────────────── */
    console.log('\n4. users.role_id SET NOT NULL');
    await client.query('ALTER TABLE users ALTER COLUMN role_id SET NOT NULL');
    console.log('  done');

    /* ── 5. verify ────────────────────────────────────────────────────── */
    console.log('\n5. Verifying');
    const problems = [];

    const { rows: nulls } = await client.query(
      'SELECT COUNT(*)::int AS c FROM users WHERE role_id IS NULL',
    );
    if (nulls[0].c !== 0) problems.push(`${nulls[0].c} user(s) still have role_id IS NULL`);

    const { rows: crossOrg } = await client.query(
      `SELECT COUNT(*)::int AS c
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.organization_id <> u.organization_id`,
    );
    if (crossOrg[0].c !== 0) {
      problems.push(`${crossOrg[0].c} user(s) hold a role from another organization`);
    }

    // The portal is what users.role must agree with — that agreement is the
    // whole reason users.role can stay untouched as the portal selector.
    const { rows: mismatch } = await client.query(
      `SELECT COUNT(*)::int AS c
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.portal <> u.role`,
    );
    if (mismatch[0].c !== 0) {
      problems.push(`${mismatch[0].c} user(s) have users.role disagreeing with roles.portal`);
    }

    const { rows: usersAfter } = await client.query('SELECT COUNT(*)::int AS c FROM users');
    if (usersAfter[0].c !== before) {
      problems.push(`users row count changed: ${before} -> ${usersAfter[0].c}`);
    }

    // Every org must end up able to administer itself (§3.8 guard 1 and 2).
    const { rows: orphanOrgs } = await client.query(
      `SELECT o.id, o.slug
         FROM organizations o
        WHERE NOT EXISTS (
          SELECT 1 FROM roles r
            JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = 'manage_roles'
           WHERE r.organization_id = o.id AND r.portal = 'admin'
        )`,
    );
    for (const o of orphanOrgs) {
      problems.push(`organization ${o.id} (${o.slug}) has no admin-portal role with manage_roles`);
    }

    if (problems.length > 0) {
      await client.query('ROLLBACK');
      console.error('\nVERIFICATION FAILED — rolled back, no changes applied:');
      for (const p of problems) console.error(`  - ${p}`);
      process.exitCode = 1;
      return;
    }

    const { rows: perRole } = await client.query(
      `SELECT o.slug, r.key, r.portal, r.scope, COUNT(u.id)::int AS users,
              (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS perms
         FROM roles r
         JOIN organizations o ON o.id = r.organization_id
         LEFT JOIN users u ON u.role_id = r.id
        GROUP BY o.slug, r.id, r.key, r.portal, r.scope
        ORDER BY o.slug, r.key`,
    );
    console.log('  OK: no NULLs, no cross-org roles, portal agrees with users.role.\n');
    console.log('  org / role / portal / scope / users / permissions');
    for (const r of perRole) {
      console.log(
        `    ${r.slug.padEnd(24)} ${r.key.padEnd(8)} ${r.portal.padEnd(8)} ` +
          `${r.scope.padEnd(11)} ${String(r.users).padStart(4)} ${String(r.perms).padStart(4)}`,
      );
    }

    /* ── summary ──────────────────────────────────────────────────────── */
    console.log('\n--- Summary ---');
    console.log(`Organizations seeded:   ${orgs.length}`);
    console.log(`Roles created:          ${rolesCreated}`);
    console.log(`Permission grants:      ${grantsCreated}`);
    console.log(`Users backfilled:       ${before}`);
    console.log(`Composite FKs added:    2 (users_role_same_org, sessions_trainer_same_org)`);
    console.log(`Columns set NOT NULL:   1 (users.role_id)`);

    if (commit) {
      await client.query('COMMIT');
      console.log('\nCOMMITTED. Roles are seeded and every user holds one.');
      console.log(
        '\nNothing enforces a permission yet — the guard and the claims are the ' +
          'next slice. Existing behaviour is unchanged: users.role still selects ' +
          'the portal and every @Roles() decorator still decides access.',
      );
    } else {
      await client.query('ROLLBACK');
      console.log(
        '\nDRY RUN — every statement above ran inside a transaction that was then ' +
          'rolled back. No changes applied. Re-run with --commit to apply.',
      );
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the transaction may never have opened */
    }
    console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

await main();
await pool.end();
