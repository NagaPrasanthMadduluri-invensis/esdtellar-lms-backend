/**
 * Creates one role inside one organization. Spec: `specs/rbac.md` §3.3, §3.6.1.
 *
 * `migrate-rbac.mjs` seeds the three roles every organization gets. This is for
 * the ones only some organizations want — a trainer, an auditor, a coordinator.
 * It exists because the roles UI does not yet: `/admin/roles` is still the mock
 * whose save handler is `() => setSaved(true)`, so until that screen is wired
 * up this script is the only way to add a role without hand-writing SQL.
 *
 *   node scripts/create-org-role.mjs --org invensis-technologies --trainer
 *   node scripts/create-org-role.mjs --org invensis-technologies --trainer --commit
 *
 *   node scripts/create-org-role.mjs --org acme --key auditor --label Auditor \
 *     --portal admin --scope org --permissions view_reports,view_certificates --commit
 *
 * Dry run is the default and runs every statement inside a transaction that is
 * then rolled back, matching the other scripts in this directory.
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
 * Mirrors PERMISSIONS in src/common/permissions.ts. Duplicated for the same
 * reason migrate-rbac.mjs and seed.mjs duplicate things: this is a plain .mjs
 * script and that file is TypeScript compiled into dist/. A key absent here is
 * rejected, so the two drifting apart fails loudly rather than silently
 * granting something no guard knows about.
 */
/**
 * KEEP IN STEP with PERMISSIONS in src/common/permissions.ts — 20 keys.
 * A key absent here is rejected, so drift fails loudly instead of granting
 * something no guard knows about. It last drifted when the catalogue dropped
 * `manage_departments` and gained `manage_certificates` / `manage_sessions`.
 */
const PERMISSIONS = [
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

const PORTALS = ['admin', 'learner', 'trainer'];
const SCOPES = ['org', 'department', 'self'];

/** The trainer shape from `TRAINER_ROLE` in src/common/permissions.ts. */
const TRAINER = {
  key: 'trainer',
  label: 'Trainer',
  portal: 'trainer',
  scope: 'self',
  permissions: ['view_own_sessions', 'view_session_participants', 'mark_attendance'],
};

function flag(name) {
  return process.argv.includes(`--${name}`);
}
function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

const commit = flag('commit');
const orgRef = option('org', '');

const role = flag('trainer')
  ? { ...TRAINER }
  : {
      key: option('key', ''),
      label: option('label', ''),
      portal: option('portal', ''),
      scope: option('scope', 'self'),
      permissions: option('permissions', '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
    };

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

let exitCode = 0;

try {
  if (!orgRef) throw new Error('--org <slug|id> is required.');
  if (!role.key) throw new Error('--key is required (or use --trainer).');
  if (!role.label) throw new Error('--label is required (or use --trainer).');
  if (!PORTALS.includes(role.portal)) {
    throw new Error(`--portal must be one of: ${PORTALS.join(', ')}`);
  }
  if (!SCOPES.includes(role.scope)) {
    throw new Error(`--scope must be one of: ${SCOPES.join(', ')}`);
  }
  const unknown = role.permissions.filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown permission(s): ${unknown.join(', ')}.\n` +
        'A permission means something only because a guard checks it, so it must ' +
        'exist in src/common/permissions.ts first.',
    );
  }

  const target = new URL(process.env.DATABASE_URL);
  console.log(`\nTarget: ${target.hostname}:${target.port || 5432}/${target.pathname.slice(1)}`);
  console.log(commit ? 'Mode:   COMMIT' : 'Mode:   dry run (rolls back at the end)');

  const client = await pool.connect();
  try {
    /* ── resolve the organization by slug or id ─────────────────────────── */
    const { rows: orgs } = await client.query(
      `SELECT id, name, slug, is_platform, perm_version FROM organizations
        WHERE slug = $1 OR id::text = $1`,
      [orgRef],
    );
    if (orgs.length === 0) {
      const { rows: all } = await client.query('SELECT id, slug FROM organizations ORDER BY id');
      throw new Error(
        `No organization matches "${orgRef}". Available: ` +
          all.map((o) => `${o.slug} (${o.id})`).join(', '),
      );
    }
    const org = orgs[0];
    console.log(`\nOrganization: [${org.id}] ${org.name} (${org.slug})`);

    /* ── one key per organization ──────────────────────────────────────── */
    const { rows: clash } = await client.query(
      'SELECT id, label, portal FROM roles WHERE organization_id = $1 AND key = $2',
      [org.id, role.key],
    );
    if (clash.length > 0) {
      throw new Error(
        `"${role.key}" already exists in this organization — role id ${clash[0].id} ` +
          `("${clash[0].label}", portal ${clash[0].portal}). Roles are edited, not re-created.`,
      );
    }

    console.log(`\n${commit ? 'Creating' : 'Would create'} role:`);
    console.log(`  key:         ${role.key}`);
    console.log(`  label:       ${role.label}`);
    console.log(`  portal:      ${role.portal}`);
    console.log(`  scope:       ${role.scope}`);
    console.log(
      `  permissions: ${role.permissions.length > 0 ? role.permissions.join(', ') : '(none)'}`,
    );

    await client.query('BEGIN');

    const { rows: created } = await client.query(
      `INSERT INTO roles (organization_id, key, label, portal, scope, is_system)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
      [org.id, role.key, role.label, role.portal, role.scope],
    );
    const roleId = created[0].id;

    let grants = 0;
    if (role.permissions.length > 0) {
      const { rowCount } = await client.query(
        `INSERT INTO role_permissions (role_id, permission)
         SELECT $1, p FROM unnest($2::text[]) AS p`,
        [roleId, role.permissions],
      );
      grants = rowCount;
    }

    /* ── decision 5: any write to roles bumps the organization's version ─
       Nobody holds this role yet, so no existing token's permissions actually
       change — but the rule is kept uniform rather than special-cased, and it
       has no effect until AuthGuard reads the claim. Once it does, creating a
       role will sign this organization out, which is why the roles UI has to
       warn before saving. */
    const { rows: bumped } = await client.query(
      'UPDATE organizations SET perm_version = perm_version + 1 WHERE id = $1 RETURNING perm_version',
      [org.id],
    );

    console.log(`\n  role id:      ${roleId}`);
    console.log(`  grants:       ${grants}`);
    console.log(`  perm_version: ${org.perm_version} -> ${bumped[0].perm_version}`);

    /* ── show the organization's full role set, as the platform admin will
         see it once the org detail page lists roles ─────────────────────── */
    const { rows: full } = await client.query(
      `SELECT r.key, r.label, r.portal, r.scope, r.is_system,
              COUNT(u.id)::int AS users,
              (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS perms
         FROM roles r LEFT JOIN users u ON u.role_id = r.id
        WHERE r.organization_id = $1
        GROUP BY r.id, r.key, r.label, r.portal, r.scope, r.is_system
        ORDER BY r.key`,
      [org.id],
    );
    console.log(`\n  ${org.slug} now has ${full.length} role(s):`);
    console.log('    key       label      portal    scope        users  perms  system');
    for (const r of full) {
      console.log(
        `    ${r.key.padEnd(9)} ${r.label.padEnd(10)} ${r.portal.padEnd(9)} ` +
          `${r.scope.padEnd(12)} ${String(r.users).padStart(5)}  ${String(r.perms).padStart(5)}  ` +
          `${r.is_system ? 'yes' : 'no'}`,
      );
    }

    if (commit) {
      await client.query('COMMIT');
      console.log(`\nCOMMITTED. "${role.label}" exists in ${org.slug}.`);
      if (role.portal === 'trainer') {
        console.log(
          '\nTo put someone in it, they need users.role = \'trainer\' and this ' +
            'role_id, and their sessions need sessions.trainer_user_id set to ' +
            'them. The trainer portal itself is the next slice.',
        );
      }
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back, nothing written. Re-run with --commit to apply.');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await pool.end();
  process.exitCode = exitCode;
}
